/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:organize-imports
// tslint:disable:ban-malformed-import-paths
// tslint:disable:no-new-decorators

import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Analyser } from './analyser';

import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { fs as backdropFS, vs as backdropVS } from './backdrop-shader';
import { vs as sphereVS } from './sphere-shader';

/**
 * 3D live audio visual.
 */
@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  @property({ type: Boolean }) showBackground = true;
  @property({ type: Boolean }) showRings = true;
  @property({ type: Boolean }) useDynamicColors = true;
  @property({ type: Boolean }) useSmoothAnimations = true;
  @property({ type: Boolean }) useAdvancedNoise = true;

  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private backdrop!: THREE.Mesh;
  private composer!: EffectComposer;
  private sphere!: THREE.Mesh;
  private ringsGroup!: THREE.Group;
  private ringMaterials: THREE.ShaderMaterial[] = [];
  private prevTime = 0;
  private rotation = new THREE.Vector3(0, 0, 0);

  private starLines!: THREE.LineSegments;
  private starPositions!: Float32Array;
  private starVelocities!: Float32Array;
  private warpFactor = 0;

  private _outputNode!: AudioNode;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }

  get inputNode() {
    return this._inputNode;
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      image-rendering: pixelated;
    }
  `;

  private init() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x100c14);

    const backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(10, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: { value: new THREE.Vector2(1, 1) },
          rand: { value: 0 },
          speed: { value: 0 },
          time: { value: 0 },
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    backdrop.material.side = THREE.BackSide;
    scene.add(backdrop);
    this.backdrop = backdrop;

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    camera.position.set(2, -2, 5);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    const geometry = new THREE.IcosahedronGeometry(1, 10);

    new EXRLoader().load('piz_compressed.exr', (texture: THREE.Texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const exrCubeRenderTarget = pmremGenerator.fromEquirectangular(texture);
      sphereMaterial.envMap = exrCubeRenderTarget.texture;
      sphere.visible = true;
      pmremGenerator.dispose();
    });

    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x000010,
      metalness: 0.9,
      roughness: 0.1,
      emissive: 0x000010,
      emissiveIntensity: 1.5,
    });

    sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.inputData = { value: new THREE.Vector4() };
      shader.uniforms.outputData = { value: new THREE.Vector4() };
      sphereMaterial.userData.shader = shader;
      shader.vertexShader = sphereVS;
    };

    const sphere = new THREE.Mesh(geometry, sphereMaterial);
    scene.add(sphere);
    sphere.visible = false;
    this.sphere = sphere;

    this.setupRings(scene);
    this.setupStarfield(scene);

    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      5, 0.5, 0,
    );
    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    this.composer = composer;

    const onWindowResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      const dPR = renderer.getPixelRatio();
      const w = window.innerWidth;
      const h = window.innerHeight;
      backdrop.material.uniforms.resolution.value.set(w * dPR, h * dPR);
      renderer.setSize(w, h);
      composer.setSize(w, h);
    };

    window.addEventListener('resize', onWindowResize);
    onWindowResize();
    this.animation();
  }

  private setupStarfield(scene: THREE.Scene) {
    const starCount = 400;
    const starPositions = new Float32Array(starCount * 6);
    const starVelocities = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      this.resetStar(i, starPositions, starVelocities);
    }

    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.LineBasicMaterial({
      color: 0xccccff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.starLines = new THREE.LineSegments(starGeometry, starMaterial);
    scene.add(this.starLines);
    this.starPositions = starPositions;
    this.starVelocities = starVelocities;
  }

  private resetStar(i: number, positions: Float32Array, velocities: Float32Array) {
    const r = 15 + Math.random() * 15;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    positions[i * 6] = x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x;
    positions[i * 6 + 4] = y;
    positions[i * 6 + 5] = z;
    const speed = 0.05 + Math.random() * 0.1;
    const dir = new THREE.Vector3(-x, -y, -z).normalize();
    velocities[i * 3] = dir.x * speed;
    velocities[i * 3 + 1] = dir.y * speed;
    velocities[i * 3 + 2] = dir.z * speed;
  }

  private setupRings(scene: THREE.Scene) {
    this.ringsGroup = new THREE.Group();
    scene.add(this.ringsGroup);

    for (let i = 0; i < 3; i++) {
      const geometry = new THREE.TorusGeometry(1.2 + i * 0.4, 0.01, 16, 100);
      const material = new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          color: { value: new THREE.Color(0x00ffff) },
          opacity: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec2 vUv;
          uniform vec3 color;
          uniform float opacity;
          uniform float time;
          void main() {
            float pulse = 0.5 + 0.5 * sin(time * 5.0 + vUv.x * 20.0);
            gl_FragColor = vec4(color, opacity * pulse);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(geometry, material);
      ring.rotation.x = Math.PI / 2;
      this.ringsGroup.add(ring);
      this.ringMaterials.push(material);
    }
  }

  private animation() {
    requestAnimationFrame(() => this.animation());
    if (!this.inputAnalyser || !this.outputAnalyser) return;

    this.inputAnalyser.update();
    this.outputAnalyser.update();

    const t = performance.now();
    const dt = (t - this.prevTime) / (1000 / 60);
    this.prevTime = t;

    const inputLevel = this.inputAnalyser.data[0] / 255;
    const outputLevel = this.outputAnalyser.data[0] / 255;

    // Background Warp Logic
    const isSpeaking = inputLevel > 0.05 || outputLevel > 0.05;
    const targetWarp = isSpeaking ? 1.0 : 0.0;
    this.warpFactor += (targetWarp - this.warpFactor) * 0.05;

    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial;
    backdropMaterial.uniforms.time.value = t * 0.001;
    backdropMaterial.uniforms.rand.value = Math.random() * 10000;
    backdropMaterial.uniforms.speed.value = this.warpFactor;
    this.backdrop.visible = this.showBackground;

    // Starfield Animation
    if (this.starLines) {
      this.starLines.visible = this.showBackground;
      const positions = this.starPositions;
      const velocities = this.starVelocities;
      const streakLength = 1.5 * this.warpFactor;

      for (let i = 0; i < 400; i++) {
        const speedMult = 1 + this.warpFactor * 15;
        positions[i * 6] += velocities[i * 3] * dt * speedMult;
        positions[i * 6 + 1] += velocities[i * 3 + 1] * dt * speedMult;
        positions[i * 6 + 2] += velocities[i * 3 + 2] * dt * speedMult;
        positions[i * 6 + 3] = positions[i * 6] - velocities[i * 3] * streakLength * 10;
        positions[i * 6 + 4] = positions[i * 6 + 1] - velocities[i * 3 + 1] * streakLength * 10;
        positions[i * 6 + 5] = positions[i * 6 + 2] - velocities[i * 3 + 2] * streakLength * 10;

        if (positions[i * 6] ** 2 + positions[i * 6 + 1] ** 2 + positions[i * 6 + 2] ** 2 < 1.0) {
          this.resetStar(i, positions, velocities);
        }
      }
      this.starLines.geometry.attributes.position.needsUpdate = true;
      (this.starLines.material as THREE.LineBasicMaterial).opacity = this.warpFactor * 0.3;
    }

    // Rings Animation
    this.ringsGroup.visible = this.showRings;
    this.ringsGroup.rotation.y += dt * 0.01 * (1 + outputLevel * 10);
    this.ringMaterials.forEach((mat, i) => {
      mat.uniforms.time.value = t * 0.001;
      const targetOpacity = outputLevel > 0.05 ? 0.4 : 0;
      mat.uniforms.opacity.value += (targetOpacity - mat.uniforms.opacity.value) * 0.1;
      const scale = 1 + outputLevel * 0.2 * (i + 1);
      this.ringsGroup.children[i].scale.set(scale, scale, scale);
    });

    // Sphere Animation
    const sphereMaterial = this.sphere.material as THREE.MeshStandardMaterial;
    if (sphereMaterial.userData.shader) {
      // Scaling
      const targetScale = 1 + (0.2 * this.outputAnalyser.data[1]) / 255;
      if (this.useSmoothAnimations) {
        this.sphere.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.1);
      } else {
        this.sphere.scale.setScalar(targetScale);
      }

      // Rotation
      const f = 0.001;
      this.rotation.x += (dt * f * 0.5 * this.outputAnalyser.data[1]) / 255;
      this.rotation.z += (dt * f * 0.5 * this.inputAnalyser.data[1]) / 255;
      this.rotation.y += (dt * f * 0.25 * this.inputAnalyser.data[2]) / 255;
      this.rotation.y += (dt * f * 0.25 * this.outputAnalyser.data[2]) / 255;

      const euler = new THREE.Euler(this.rotation.x, this.rotation.y, this.rotation.z);
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const vector = new THREE.Vector3(0, 0, 5);
      vector.applyQuaternion(quaternion);

      if (this.useSmoothAnimations) {
        this.camera.position.lerp(vector, 0.05);
      } else {
        this.camera.position.copy(vector);
      }
      this.camera.lookAt(this.sphere.position);

      // Colors
      if (this.useDynamicColors) {
        const aiColor = new THREE.Color(0x00ffff);
        const userColor = new THREE.Color(0xff00ff);
        const baseColor = new THREE.Color(0x000010);
        const targetEmissive = baseColor.clone().lerp(userColor, inputLevel).lerp(aiColor, outputLevel);
        sphereMaterial.emissive.lerp(targetEmissive, 0.1);
        sphereMaterial.emissiveIntensity = 1.5 + outputLevel * 5.0 + inputLevel * 2.0;
      } else {
        sphereMaterial.emissive.setHex(0x000010);
        sphereMaterial.emissiveIntensity = 1.5;
      }

      sphereMaterial.userData.shader.uniforms.time.value += (dt * 0.1 * outputLevel);
      sphereMaterial.userData.shader.uniforms.inputData.value.set(
        inputLevel, this.inputAnalyser.data[1] / 255, this.inputAnalyser.data[2] / 255, 0
      );
      sphereMaterial.userData.shader.uniforms.outputData.value.set(
        outputLevel, this.outputAnalyser.data[1] / 255, this.outputAnalyser.data[2] / 255, 0
      );
    }

    this.composer.render();
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    this.init();
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}
