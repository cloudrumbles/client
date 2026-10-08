#version 450
layout(location=6) in vec4 pomme_MeshMaterial;
layout(set=0,binding=0) uniform PommeFrame { bool pomme_ActorInputs; vec3 pomme_ActorMaterial; };
#define pomme_EffectiveMaterial (pomme_ActorInputs?pomme_ActorMaterial:pomme_MeshMaterial)
void main(){gl_Position=vec4(pomme_EffectiveMaterial.x,0,0,1);}
