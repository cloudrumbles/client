#version 330 compatibility
/* RENDERTARGETS: 0 */
varying vec4 material;
void main(){gl_FragColor=vec4(material.x/100.0,material.y+material.z,material.w/2.0,1.0);}
