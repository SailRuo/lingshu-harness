<template>
  <div ref="container" class="vrm-container" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRM } from "@pixiv/three-vrm";

const container = ref<HTMLDivElement>();

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let vrm: VRM | null = null;
let animId = 0;

onMounted(async () => {
  if (!container.value) return;

  const w = container.value.clientWidth;
  const h = container.value.clientHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 20);
  camera.position.set(0, 1.2, -3.5);
  camera.lookAt(0, 1.0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.value.appendChild(renderer.domElement);

  // lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(1, 2, 2);
  scene.add(dir);

  const fill = new THREE.DirectionalLight(0x8888ff, 0.4);
  fill.position.set(-1, 0.5, 1);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.3);
  rim.position.set(0, 1, -2);
  scene.add(rim);

  // floor
  const grid = new THREE.GridHelper(4, 20, 0x444466, 0x333355);
  grid.position.y = -0.01;
  scene.add(grid);

  // load VRM
  const loader = new GLTFLoader();
  loader.register((parser: any) => new VRMLoaderPlugin(parser));
  loader.load(
    "/lingshu-models/AvatarSample_A.vrm",
    (gltf: any) => {
      vrm = gltf.userData.vrm as VRM;
      if (!vrm) return;
      scene.add(vrm.scene);
      if (vrm.expressionManager) {
        vrm.expressionManager.setValue("happy", 0.3);
        vrm.update(0);
      }
    },
    (xhr: ProgressEvent) => {
      if (xhr.total > 0) {
        console.log(`VRM: ${Math.round((xhr.loaded / xhr.total) * 100)}%`);
      }
    },
    (err: unknown) => console.error("VRM load error:", err)
  );

  // animate
  const clock = new THREE.Clock();
  const loop = () => {
    animId = requestAnimationFrame(loop);
    const delta = clock.getDelta();

    if (vrm) {
      vrm.update(delta);
    }

    // gentle rotation
    const el = scene.children.find((c: THREE.Object3D) => c !== grid);
    if (el) el.rotation.y += delta * 0.3;

    renderer.render(scene, camera);
  };
  loop();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animId);
  renderer?.dispose();
  container.value?.querySelector("canvas")?.remove();
});
</script>

<style scoped>
.vrm-container {
  width: 100%;
  height: 100vh;
  overflow: hidden;
}
</style>