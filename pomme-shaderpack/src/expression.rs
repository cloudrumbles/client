//! Pack-defined custom uniforms, evaluated from frame inputs. `smooth`
//! histories belong to the expression call, and are discarded on
//! discontinuities/reload.
use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{Context, Result, bail, ensure};

#[derive(Clone, Debug)]
pub struct Value(pub Vec<f64>);
impl Value {
    pub fn scalar(x: f64) -> Self {
        Self(vec![x])
    }
    pub fn first(&self) -> f64 {
        self.0[0]
    }
    fn binary(&self, b: &Self, f: impl Fn(f64, f64) -> f64) -> Self {
        Self(
            (0..self.0.len().max(b.0.len()))
                .map(|i| f(self.0[i % self.0.len()], b.0[i % b.0.len()]))
                .collect(),
        )
    }
}
#[derive(Clone, Debug)]
enum Expr {
    Number(f64),
    Name(String),
    Unary(String, Box<Expr>),
    Binary(String, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>, usize),
}
struct Parser {
    tokens: Vec<String>,
    index: usize,
    calls: usize,
}
impl Parser {
    fn new(s: &str) -> Result<Self> {
        let re = regex::Regex::new(
            r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*(?:\.(?:\d+|[xyzwrgbastpq]))*|&&|\|\||==|!=|<=|>=|[()+*/%,!<>=^-]",
        )?;
        let tokens = re.find_iter(s).map(|m| m.as_str().to_owned()).collect();
        let unparsed = re.replace_all(s, "");
        ensure!(
            unparsed.trim().is_empty(),
            "invalid expression tokens {unparsed}"
        );
        Ok(Self {
            tokens,
            index: 0,
            calls: 0,
        })
    }
    fn peek(&self) -> &str {
        self.tokens
            .get(self.index)
            .map(String::as_str)
            .unwrap_or("")
    }
    fn pop(&mut self) -> String {
        let s = self.peek().to_owned();
        self.index += 1;
        s
    }
    fn expr(&mut self, min: u8) -> Result<Expr> {
        let t = self.pop();
        let mut left = match t.as_str() {
            "(" => {
                let e = self.expr(0)?;
                ensure!(self.pop() == ")", "missing )");
                e
            }
            "-" | "!" | "+" => Expr::Unary(t, Box::new(self.expr(8)?)),
            "" => bail!("missing expression"),
            _ => {
                if let Ok(n) = t.parse() {
                    Expr::Number(n)
                } else if self.peek() == "(" {
                    self.pop();
                    let mut args = Vec::new();
                    if self.peek() != ")" {
                        loop {
                            args.push(self.expr(0)?);
                            if self.peek() != "," {
                                break;
                            }
                            self.pop();
                        }
                    }
                    ensure!(self.pop() == ")", "missing function )");
                    self.calls += 1;
                    Expr::Call(t, args, self.calls)
                } else {
                    Expr::Name(t)
                }
            }
        };
        loop {
            let p = match self.peek() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" => 3,
                "<" | ">" | "<=" | ">=" => 4,
                "+" | "-" => 5,
                "*" | "/" | "%" => 6,
                "^" => 7,
                _ => 0,
            };
            if p == 0 || p < min {
                break;
            }
            let op = self.pop();
            let right = self.expr(p + 1)?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }
}

pub struct Uniforms {
    expressions: BTreeMap<String, Expr>,
    pub types: BTreeMap<String, String>,
    history: HashMap<String, Value>,
}
impl Uniforms {
    pub fn new(properties: &BTreeMap<String, String>) -> Result<Self> {
        let mut expressions = BTreeMap::new();
        let mut types = BTreeMap::new();
        for (key, value) in properties {
            if !(key.starts_with("uniform.") || key.starts_with("variable.")) {
                continue;
            }
            let fields = key.split('.').collect::<Vec<_>>();
            ensure!(fields.len() == 3, "invalid custom uniform {key}");
            let mut parser =
                Parser::new(value).with_context(|| format!("custom expression {key}: {value}"))?;
            let expr = parser.expr(0)?;
            ensure!(
                parser.peek().is_empty(),
                "trailing expression tokens for {key}"
            );
            expressions.insert(fields[2].into(), expr);
            if fields[0] == "uniform" {
                types.insert(fields[2].into(), fields[1].into());
            }
        }
        Ok(Self {
            expressions,
            types,
            history: HashMap::new(),
        })
    }
    pub fn reset(&mut self) {
        self.history.clear();
    }
    pub fn evaluate(
        &mut self,
        base: &BTreeMap<String, Value>,
        dt: f64,
    ) -> Result<BTreeMap<String, Value>> {
        let mut values = base.clone();
        let names = self.expressions.keys().cloned().collect::<Vec<_>>();
        for name in names {
            self.resolve(&name, &mut values, &mut HashSet::new(), dt)?;
        }
        Ok(values)
    }
    fn resolve(
        &mut self,
        name: &str,
        values: &mut BTreeMap<String, Value>,
        stack: &mut HashSet<String>,
        dt: f64,
    ) -> Result<Value> {
        if let Some(v) = values.get(name) {
            return Ok(v.clone());
        }
        if let Some((vector, component)) = name.rsplit_once('.')
            && let Some(index) = ["xrs", "ygt", "zbp", "waq"]
                .iter()
                .position(|c| c.contains(component))
        {
            let value = self.resolve(vector, values, stack, dt)?;
            return Ok(Value::scalar(
                *value
                    .0
                    .get(index)
                    .context("vector component out of bounds")?,
            ));
        }
        if name == "true" || name == "false" {
            return Ok(Value::scalar((name == "true") as u8 as f64));
        }
        ensure!(stack.insert(name.into()), "custom uniform cycle at {name}");
        let expr = self
            .expressions
            .get(name)
            .with_context(|| format!("unknown uniform input {name}"))?
            .clone();
        let value = self.eval(&expr, name, values, stack, dt)?;
        ensure!(
            value.0.iter().all(|v| v.is_finite()),
            "nonfinite custom uniform {name}: {:?}",
            value.0
        );
        values.insert(name.into(), value.clone());
        stack.remove(name);
        Ok(value)
    }
    fn eval(
        &mut self,
        e: &Expr,
        owner: &str,
        values: &mut BTreeMap<String, Value>,
        stack: &mut HashSet<String>,
        dt: f64,
    ) -> Result<Value> {
        let boolean = |b: bool| if b { 1.0 } else { 0.0 };
        match e {
            Expr::Number(n) => Ok(Value::scalar(*n)),
            Expr::Name(n) => self.resolve(n, values, stack, dt),
            Expr::Unary(op, a) => {
                let a = self.eval(a, owner, values, stack, dt)?;
                Ok(Value(
                    a.0.iter()
                        .map(|x| match op.as_str() {
                            "-" => -x,
                            "!" => boolean(*x == 0.0),
                            _ => *x,
                        })
                        .collect(),
                ))
            }
            Expr::Binary(op, a, b) => {
                let a = self.eval(a, owner, values, stack, dt)?;
                let b = self.eval(b, owner, values, stack, dt)?;
                Ok(a.binary(&b, |x, y| match op.as_str() {
                    "+" => x + y,
                    "-" => x - y,
                    "*" => x * y,
                    "/" => x / y,
                    "%" => x % y,
                    "^" => x.powf(y),
                    "==" => boolean(x == y),
                    "!=" => boolean(x != y),
                    "<" => boolean(x < y),
                    ">" => boolean(x > y),
                    "<=" => boolean(x <= y),
                    ">=" => boolean(x >= y),
                    "&&" => boolean(x != 0.0 && y != 0.0),
                    "||" => boolean(x != 0.0 || y != 0.0),
                    _ => f64::NAN,
                }))
            }
            Expr::Call(name, args, id) => {
                let arity = args.len();
                let valid = match name.as_str() {
                    "vec2" | "vec3" | "vec4" => arity > 0,
                    "if" => arity >= 3 && arity % 2 == 1,
                    "in" => arity >= 2,
                    "min" | "max" | "pow" => arity == 2,
                    "clamp" | "equals" | "between" => arity == 3,
                    "smooth" => (2..=3).contains(&arity),
                    "abs" | "sqrt" | "sin" | "cos" | "tan" | "atan" | "exp" | "floor" | "ceil"
                    | "frac" => arity == 1,
                    _ => false,
                };
                ensure!(
                    valid,
                    "unsupported function or arity {name}({arity} arguments)"
                );
                let a = args
                    .iter()
                    .map(|a| self.eval(a, owner, values, stack, dt))
                    .collect::<Result<Vec<_>>>()?;
                let n = |i: usize| a.get(i).map(Value::first).unwrap_or(0.0);
                let unary = |f: fn(f64) -> f64| Value(a[0].0.iter().map(|x| f(*x)).collect());
                ensure!(!a.is_empty(), "empty function {name}");
                Ok(match name.as_str() {
                    "vec2" | "vec3" | "vec4" => {
                        let count = name[3..].parse::<usize>()?;
                        let v = a
                            .iter()
                            .flat_map(|v| v.0.iter().copied())
                            .collect::<Vec<_>>();
                        ensure!(v.len() == 1 || v.len() == count, "vector arity");
                        Value((0..count).map(|i| v[i % v.len()]).collect())
                    }
                    "if" => {
                        ensure!(a.len() >= 3 && a.len() % 2 == 1, "if arity");
                        let mut value = a.last().unwrap().clone();
                        for pair in a[..a.len() - 1].chunks(2) {
                            if pair[0].first() != 0.0 {
                                value = pair[1].clone();
                                break;
                            }
                        }
                        value
                    }
                    "min" => a[0].binary(&a[1], f64::min),
                    "max" => a[0].binary(&a[1], f64::max),
                    "pow" => a[0].binary(&a[1], f64::powf),
                    "clamp" => Value(a[0].0.iter().map(|x| x.clamp(n(1), n(2))).collect()),
                    "abs" => unary(f64::abs),
                    "sqrt" => unary(f64::sqrt),
                    "sin" => unary(f64::sin),
                    "cos" => unary(f64::cos),
                    "tan" => unary(f64::tan),
                    "atan" => unary(f64::atan),
                    "exp" => unary(f64::exp),
                    "floor" => unary(f64::floor),
                    "ceil" => unary(f64::ceil),
                    "frac" => Value(a[0].0.iter().map(|x| x - x.floor()).collect()),
                    "between" => Value::scalar(boolean(n(0) >= n(1) && n(0) <= n(2))),
                    "equals" => Value::scalar(boolean((n(0) - n(1)).abs() <= n(2))),
                    "in" => Value::scalar(boolean(a[1..].iter().any(|v| v.first() == n(0)))),
                    "smooth" => {
                        let key = format!("{owner}:{id}");
                        let target = a[0].clone();
                        let old = self
                            .history
                            .get(&key)
                            .cloned()
                            .unwrap_or_else(|| target.clone());
                        let half = if target.first() > old.first() {
                            n(1)
                        } else {
                            a.get(2).map(Value::first).unwrap_or(n(1))
                        };
                        let alpha = if half <= 0.0 {
                            1.0
                        } else {
                            1.0 - (-dt * std::f64::consts::LN_2 / half).exp()
                        };
                        let value = old.binary(&target, |x, y| x + (y - x) * alpha);
                        self.history.insert(key, value.clone());
                        value
                    }
                    _ => bail!("unsupported custom uniform function {name}"),
                })
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expressions_follow_frame_and_reset() {
        let props = BTreeMap::from([
            ("variable.float.a".into(), "frac(frameCounter * 1.5)".into()),
            (
                "uniform.vec2.b".into(),
                "vec2(a, smooth(value, 1.0, 1.0))".into(),
            ),
        ]);
        let mut u = Uniforms::new(&props).unwrap();
        let mut inputs = BTreeMap::from([
            ("frameCounter".into(), Value::scalar(1.0)),
            ("value".into(), Value::scalar(0.0)),
        ]);
        assert_eq!(u.evaluate(&inputs, 1.0).unwrap()["b"].0, vec![0.5, 0.0]);
        inputs.insert("value".into(), Value::scalar(1.0));
        assert_eq!(u.evaluate(&inputs, 1.0).unwrap()["b"].0, vec![0.5, 0.5]);
        u.reset();
        assert_eq!(u.evaluate(&inputs, 1.0).unwrap()["b"].0, vec![0.5, 1.0]);
    }
    #[test]
    fn missing_inputs_and_cycles_fail() {
        let mut u =
            Uniforms::new(&BTreeMap::from([("uniform.float.x".into(), "x+1".into())])).unwrap();
        assert!(u.evaluate(&BTreeMap::new(), 0.1).is_err());
    }
}
