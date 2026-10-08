#version 330 compatibility
attribute vec3 mc_Entity;
varying vec4 material;
void main(){material=vec4(mc_Entity,1.0);gl_Position=ftransform();}
