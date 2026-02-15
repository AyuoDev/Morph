import * as THREE from "three";
import { GLTFLoader } from "https://unpkg.com/three@0.158.0/examples/jsm/loaders/GLTFLoader.js";
import {
  getPreviewRenderer,
  registerPreview,
  unregisterPreview
} from "./PreviewManager.js";

function disposeObject(object) {
  object.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
      else o.material.dispose();
    }
  });
}

export function createPreview({
  container,
  gltfPath = null,
  animationPath = null,
  baseMeshPath = null,
  autoRotate = true
}) {
  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  getPreviewRenderer();

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(4, 6, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-4, 2, -4);
  scene.add(fill);

  const preview = {
    scene, camera,
    root: null, mixer: null,
    clock: new THREE.Clock(),
    container, autoRotate: true, rotationSpeed: 0.003
  };

  const loader = new GLTFLoader();

  // Silent error — a broken thumbnail must NEVER throw to console as an uncaught error
  const silentErr = (label) => () =>
    console.warn("Preview thumbnail skipped:", label);

  const isClothingPreview = !!gltfPath && !baseMeshPath && !animationPath;

  if (animationPath && baseMeshPath) {
    loader.load(baseMeshPath,
      baseGLTF => {
        preview.root = baseGLTF.scene;
        scene.add(preview.root);
        loader.load(animationPath,
          animGLTF => {
            if (!animGLTF.animations.length) return;
            preview.mixer = new THREE.AnimationMixer(preview.root);
            const action = preview.mixer.clipAction(animGLTF.animations[0]);
            action.loop = THREE.LoopRepeat;
            action.play();
            preview.mixer.update(0);
            frameObject(preview.root);
          },
          undefined, silentErr("animation")
        );
      },
      undefined, silentErr("basemesh")
    );
  } else if (gltfPath) {
    loader.load(gltfPath,
      gltf => {
        preview.root = gltf.scene;
        scene.add(preview.root);
        if (!isClothingPreview && gltf.animations?.length) {
          preview.mixer = new THREE.AnimationMixer(preview.root);
          const action = preview.mixer.clipAction(gltf.animations[0]);
          action.loop = THREE.LoopRepeat;
          action.play();
          preview.mixer.update(0);
        }
        frameObject(preview.root);
      },
      undefined, silentErr("gltf")
    );
  }

  function frameObject(object) {
    object.updateWorldMatrix(true, true);
    const box    = new THREE.Box3().setFromObject(object);
    const size   = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.near = maxDim / 100;
    camera.far  = maxDim * 100;
    camera.updateProjectionMatrix();
    camera.position.set(center.x, center.y + maxDim * 0.35, center.z + maxDim * 1.8);
    camera.position.multiplyScalar(1.1);
    camera.lookAt(center);
  }

  preview.autoRotate    = isClothingPreview || autoRotate;
  preview.rotationSpeed = isClothingPreview ? 0.006 : 0.002 + Math.random() * 0.003;
  registerPreview(preview);

  return {
    dispose() {
      unregisterPreview(preview);
      if (preview.root) { disposeObject(preview.root); preview.root = null; }
      preview.mixer = null;
      container.innerHTML = "";
    }
  };
}
