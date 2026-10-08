import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitEnvironmentFog,nativeFogColorToLinear } from '../src/render-environment-fog.js';
const sample={type:'water',color:[.04045,.5,1],colorEncoding:'native-rgb',start:-8,end:24,skyEnd:24,shape:'sphere',renderStart:115.2,renderEnd:128,separateRenderDistance:false};
test('source RGB is converted once after native blending, retaining source input and HDR semantic metadata',()=>{
 const before=structuredClone(sample), admitted=admitEnvironmentFog(sample);
 assert.deepEqual(sample,before);assert.deepEqual(admitted.sourceColor,sample.color);
 assert.ok(Math.abs(admitted.color[0]-.0031308049535603713)<1e-12);assert.ok(Math.abs(admitted.color[1]-.21404114048223255)<1e-12);assert.equal(admitted.color[2],1);
 assert.equal(admitted.colorEncoding,'linear-hdr');assert.equal(admitted.sourceColorEncoding,'native-rgb');admitted.sourceColor[0]=0;assert.deepEqual(sample,before);
});
test('disabled, legacy spherical/cylindrical, modern separate-distance and effect states remain distinct',()=>{
 assert.equal(admitEnvironmentFog(null),null);assert.equal(admitEnvironmentFog(undefined),null);
 assert.equal(admitEnvironmentFog(sample).code,1);assert.equal(admitEnvironmentFog({...sample,shape:'cylinder'}).shape,'cylinder');
 assert.equal(admitEnvironmentFog({...sample,separateRenderDistance:true}).separateRenderDistance,true);
 assert.equal(admitEnvironmentFog({...sample,type:'none'}).code,4);assert.equal(admitEnvironmentFog({...sample,type:'none'}).immersed,false);
 for(const [type,code]of[['lava',2],['powder-snow',3]])assert.equal(admitEnvironmentFog({...sample,type}).code,code);
});
test('unknown encoding, nonfinite distances/colors and malformed native states reject before uniform admission',()=>{
 for(const patch of[{type:'steam'},{type:'constructor'},{colorEncoding:undefined},{colorEncoding:'linear-hdr'},{color:[NaN,0,0]},{color:[1.1,0,0]},{color:[-1,0,0]},{end:Infinity},{end:1e100},{start:NaN},{shape:'cone'}])assert.throws(()=>admitEnvironmentFog({...sample,...patch}));
 assert.throws(()=>nativeFogColorToLinear([1,0]));
});
