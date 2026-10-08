// Numeric getter goldens independently checked by native-source-numeric-java.mjs
// against the original private classes for both versions, with no Java stubs.
export const sourceInventoryNumericVectors = [5, 6].flatMap(type => [
  { value: -105.5, legacyInt: -106, modernInt: -105, legacyByte: 150, modernByte: 151 },
  { value: -255.5, legacyInt: -256, modernInt: -255, legacyByte: 0, modernByte: 1 },
  { value: -254.5, legacyInt: -255, modernInt: -254, legacyByte: 1, modernByte: 2 },
  { value: 1.9, legacyInt: 1, modernInt: 1, legacyByte: 1, modernByte: 1 },
  { value: 2147483648, legacyInt: 2147483647, modernInt: 2147483647, legacyByte: 255, modernByte: 255 },
  { value: -2147483648.5, legacyInt: type === 5 ? -2147483648 : 2147483647, modernInt: -2147483648, legacyByte: type === 5 ? 0 : 255, modernByte: 0 },
  { value: -Infinity, legacyInt: 2147483647, modernInt: -2147483648, legacyByte: 255, modernByte: 0 },
  { value: Infinity, legacyInt: 2147483647, modernInt: 2147483647, legacyByte: 255, modernByte: 255 },
  { value: NaN, legacyInt: 0, modernInt: 0, legacyByte: 0, modernByte: 0 },
].map(vector => ({ type, ...vector })));
