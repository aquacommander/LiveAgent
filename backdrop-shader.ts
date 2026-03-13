/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
const vs = `precision highp float;

in vec3 position;
out vec3 vPosition;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

void main() {
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;

const fs = `precision highp float;

in vec3 vPosition;
out vec4 fragmentColor;

uniform vec2 resolution;
uniform float time;
uniform float rand;
uniform float speed;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  uv -= 0.5;
  uv.x *= resolution.x / resolution.y;

  float angle = atan(uv.y, uv.x);
  float dist = length(uv);

  // Warp speed effect
  float s = speed * 0.5 + 0.1;
  float t = time * s;
  
  vec3 color = vec3(0.02, 0.03, 0.08); // Deep space blue

  // Stars/Streaks
  for(float i = 0.0; i < 40.0; i++) {
    float h = hash(vec2(i, 0.0));
    float a = h * 6.28318;
    float r = fract(h * 10.0 + t * (0.5 + h));
    
    vec2 p = vec2(cos(a), sin(a)) * r * 2.0;
    float streak = smoothstep(0.02, 0.0, length(uv - p * dist));
    
    // Streaks get longer as they move out
    float len = 0.1 + s * 0.5;
    float d = length(uv - p);
    float f = smoothstep(len, 0.0, d);
    
    vec3 streakColor = mix(vec3(0.1, 0.4, 1.0), vec3(0.5, 0.8, 1.0), h);
    color += streakColor * f * (0.1 / (dist + 0.1)) * s;
  }

  // Nebula glow
  color += vec3(0.05, 0.1, 0.2) * (1.0 - dist);

  fragmentColor = vec4(color, 1.0);
}
`;

export { fs, vs };
