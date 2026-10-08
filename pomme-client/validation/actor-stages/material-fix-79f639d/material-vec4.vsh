#version 330 compatibility
attribute vec4 mc_Entity;
varying vec4 material;
void main(){material=mc_Entity;gl_Position=ftransform();}
