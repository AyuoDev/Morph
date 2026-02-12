import * as THREE from "three";
import { GLTFLoader } from "https://unpkg.com/three@0.158.0/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "https://unpkg.com/three@0.158.0/examples/jsm/exporters/GLTFExporter.js";


import { initPlansOverlayControls } from "./js/Controls.js";
import { BASE_MESHES } from "./data/baseMeshes.js";
import { CLOTHES } from "./data/clothesData.js";
import { TEXTURE_PRESETS } from "./data/textures.presets.js";
import { ANIMATIONS } from "./data/animationsData.js";
import { createPreview } from "./js/PreviewRenderer.js";
import { TexturePainter } from "./js/TexturePainter.js";
/* ---------------- GLOBAL STATE ---------------- */

let scene, camera, renderer, controls;
let loader;
let mixer = null;
let currentModel = null;
let currentBaseMesh = null;
let baseSkinnedMeshes = [];
let materialTargets = {};
let activeMaterialTarget = null;
let activeAction = null;
let isPainterMode = false;
let originalViewportParent = null;
let texturePainter = null;
let painterCanvas = null;
let painterTargetMesh = null;
let isPainting = false;

let uvOverlayImage = null;
let showUVOverlay = true; // later we’ll toggle this
let uvOpacity = 0.25;
const paintedTextures = {};
const clock = new THREE.Clock();
const blendShapeMap = {};
const morphMeshes = [];
const morphValues = {};
let equippedClothes = {
  shirt: null,
  pants: null,
  gloves: null,
  shoes: null,
  hair: null,
  jacket: null,
  facialHair: null,
  headwear: null,
  glasses: null,
  accessories: null
};
const randomizerConfig = {
  baseMesh: true,
  clothes: true,
  textures: true,
  colors: true,
  blendShapes: true,
  animation: true
};

let loadedClothingMeshes = {};

/* ---------------- UI MODES ---------------- */

const topButtons = document.querySelectorAll(".top-btn[data-mode]");
const allPanels = [
  "basemesh-panel",
  "blendshape-panel",
  "clothes-panel",
  "clothes-items-panel",
  "material-panel",
  "animations-panel",
  "randomizer-panel"
];

const MODE_PANELS = {
  base: ["basemesh-panel"],
  customize: ["blendshape-panel"],
  clothes: ["clothes-panel", "clothes-items-panel"],
  materials: ["material-panel"],
  animations: ["animations-panel"],
  randomizer: ["randomizer-panel"]
};

topButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    setUIMode(btn.dataset.mode);
  });
});

function setUIMode(mode) {
  // Button active state
  topButtons.forEach(b => b.classList.remove("active"));
  document
    .querySelector(`.top-btn[data-mode="${mode}"]`)
    ?.classList.add("active");

  // Hide all panels
  allPanels.forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.classList.remove("active");
  });

  // Show panels for mode
  MODE_PANELS[mode]?.forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.classList.add("active");
  });
    if (mode === "materials") {
      rebuildMaterialTargets();
  rebuildMaterialTargetsUI();
  syncMaterialUI();
  buildTextureGrid();
  }
  if (mode === "animations") {
  buildAnimationUI();
}
if(mode === "customize"){
    buildBlendShapeUI();
}
}

/* ---------------- BOOT ---------------- */
init();
buildBaseMeshUI();
setUIMode("base");
initPlansOverlayControls();

/* ---------------- INIT ---------------- */

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e1e1e);

  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    1000
  );
  camera.position.set(0, 1.5, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  document.getElementById("viewport").appendChild(renderer.domElement);

  setupLights();
  setupControls();
  addGroundGrid();

  loader = new GLTFLoader();

  window.addEventListener("resize", onResize);
  onResize();
  animate();
}
/* ---------------- BASE MESH UI ---------------- */
function buildBaseMeshUI() {
  const panel = document.getElementById("basemesh-panel");
  panel.innerHTML = "";

  BASE_MESHES.forEach(mesh => {
    const card = document.createElement("div");
    card.className = "base-mesh-card";
    card.dataset.id = mesh.id;

    const preview = document.createElement("div");
    preview.className = "preview-canvas";

    const name = document.createElement("div");
    name.className = "base-mesh-name";
    name.textContent = mesh.name;

    card.append(preview, name);
    panel.appendChild(card);

    createPreview({
      container: preview,
      gltfPath: mesh.path
    });

    card.onclick = () => {
      document.querySelectorAll(".base-mesh-card")
        .forEach(c => c.classList.remove("active"));

      card.classList.add("active");
      loadBaseMesh(mesh);
      updateResetButton();
    };
  });
}

/* ---------------- LOAD BASE MESH ---------------- */
function loadBaseMesh(meshData) {
  if (!meshData) return;

  resetClothingUI();   // 🔑 ADD THIS
  currentBaseMesh = meshData;

  loader.load(meshData.path + "?" + Date.now(), gltf => {
    onModelLoaded(gltf);
  });
}
function onModelLoaded(gltf) {
  cleanupPreviousModel();

  currentModel = gltf.scene;
  scene.add(currentModel);

  normalizeModel(currentModel);
  collectMeshes(currentModel);
  setupAnimation(gltf);
  collectBlendShapes(currentModel);
  frameCameraToObject(currentModel);
  rebuildMaterialTargets();
}
/* ---------------- MODEL HELPERS ---------------- */
function cleanupPreviousModel() {
  if (!currentModel) return;

  scene.remove(currentModel);

  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }

  morphMeshes.length = 0;
  baseSkinnedMeshes.length = 0;

  Object.keys(morphValues).forEach(k => delete morphValues[k]);

  equippedClothes = {
    shirt: null,
    pants: null,
    gloves: null,
    shoes: null,
    hair: null,
    jacket: null,
    facialHair: null,
    headwear: null,
    glasses: null,
    accessories: null
  };
  activeAction = null;

  loadedClothingMeshes = {};
}
function normalizeModel(root) {
  root.rotation.y = Math.PI;
  root.scale.setScalar(1);
}
function collectMeshes(root) {
  root.traverse(obj => {
    if (obj.isSkinnedMesh) {
      obj.frustumCulled = false;
      baseSkinnedMeshes.push(obj);

      if (obj.morphTargetDictionary) {
        morphMeshes.push(obj);
      }
    }
  });
}
function setupAnimation(gltf) {
  if (!gltf.animations.length) return;

  mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
}
/* ---------------- BLEND SHAPES ---------------- */
function collectBlendShapes(root) {
  Object.keys(blendShapeMap).forEach(k => delete blendShapeMap[k]);

  root.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.morphTargetDictionary) return;

    for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
      if (!blendShapeMap[name]) blendShapeMap[name] = [];
      blendShapeMap[name].push({ mesh: obj, index });
    }
  });
}
function applyMorphsPerFrame() {
  for (const name in morphValues) {
    blendShapeMap[name]?.forEach(({ mesh, index }) => {
      mesh.morphTargetInfluences[index] = morphValues[name];
    });
  }
}
function collectBlendShapesFromObject(root) {
  root.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.morphTargetDictionary) return;

    for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
      if (!blendShapeMap[name]) blendShapeMap[name] = [];
      blendShapeMap[name].push({ mesh: obj, index });
    }
  });
}

/* ---------------- UI: BLEND SHAPES ---------------- */
function buildBlendShapeUI() {
  const panel = document.getElementById("blendshape-panel");
  panel.innerHTML = "";

  const keys = Object.keys(blendShapeMap).sort();

  if (keys.length === 0) {
    panel.innerHTML = `
      <p style="color:#888;font-size:13px;">
        This base mesh has no blendshapes.
      </p>
    `;
    return;
  }

  keys.forEach(name => {
    // 🔑 READ CURRENT VALUE FROM MESH
    const entry = blendShapeMap[name][0];
    const currentValue =
      entry.mesh.morphTargetInfluences[entry.index] || 0;

    morphValues[name] = currentValue;

    const row = document.createElement("div");
    row.className = "blend-row";

    const label = document.createElement("label");
    label.textContent = name;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = 0;
    slider.max = 100;
    slider.value = Math.round(currentValue * 100);

    slider.oninput = () => {
      morphValues[name] = slider.value / 100;
    };

    row.append(label, slider);
    panel.appendChild(row);
  });
}

/* ---------------- CLOTHES UI ---------------- */
const clothesCategoryButtons = document.querySelectorAll(".clothes-category");
const clothesItemsTitle = document.getElementById("clothes-items-title");
const clothesItemsGrid = document.querySelector(".clothes-items-grid");
const clothesItemsPanel = document.getElementById("clothes-items-panel");

clothesCategoryButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const category = btn.dataset.category;

    clothesCategoryButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    clothesItemsPanel.classList.add("active"); // ✅ ADD THIS
    clothesItemsTitle.textContent = category;

    buildClothingList(category);
  });
});

function getClothesFor(baseMeshId, category) {
  return CLOTHES.filter(c =>
    c.baseMesh === baseMeshId &&
    c.category === category
  );
}
function buildClothingList(category) {
  const panel = clothesItemsGrid;
  panel.innerHTML = "";

  if (!currentBaseMesh) {
    panel.innerHTML = "<p>Select a base mesh first.</p>";
    return;
  }

  // 🔹 NONE OPTION
const noneCard = document.createElement("div");
noneCard.className = "clothing-card none-card";

const preview = document.createElement("div");
preview.className = "clothing-preview";

const text = document.createElement("span");
text.textContent = "None";
text.style.fontSize = "12px";
text.style.color = "#777";

preview.appendChild(text);
noneCard.appendChild(preview);

const label = document.createElement("div");
label.className = "clothing-label";
label.textContent = "None";
noneCard.appendChild(label);

noneCard.onclick = () => unequipClothing(category);
panel.appendChild(noneCard);


  const items = getClothesFor(currentBaseMesh.id, category);

  if (items.length === 0) return;

  items.forEach(item => {
const card = document.createElement("div");
card.className = "clothing-card";

const preview = document.createElement("div");
preview.className = "clothing-preview";

createPreview({
  container: preview,
  gltfPath: item.path
});

card.appendChild(preview);

const label = document.createElement("div");
label.className = "clothing-label";
label.textContent = item.name;

card.appendChild(label);

card.onclick = () => equipClothing(item);
panel.appendChild(card);

  });
}
async function equipClothing(item) {
  // Unequip existing
  if (equippedClothes[item.category]) {
    unequipClothing(item.category);
  }

  const gltf = await loader.loadAsync(item.path);
  const clothingRoot = gltf.scene;

  const characterSkinnedMesh = getFirstSkinnedMesh(currentModel);
  if (!characterSkinnedMesh) {
    console.error("Character has no skinned mesh");
    return;
  }

  const characterSkeleton = characterSkinnedMesh.skeleton;
  const bindMatrix = characterSkinnedMesh.bindMatrix.clone();

  clothingRoot.traverse(obj => {
    if (obj.isSkinnedMesh) {
      // 🔑 CRITICAL FIX
      obj.bind(characterSkeleton, bindMatrix);
      obj.frustumCulled = false;
    }
  });

  currentModel.add(clothingRoot);
// 🔑 REGISTER CLOTHING BLEND SHAPES
collectBlendShapesFromObject(clothingRoot);

// 🔑 SYNC CLOTHING TO CURRENT MORPH VALUES
Object.entries(morphValues).forEach(([name, value]) => {
  blendShapeMap[name]?.forEach(({ mesh, index }) => {
    mesh.morphTargetInfluences[index] = value;
  });
});

  equippedClothes[item.category] = item.id;
  loadedClothingMeshes[item.id] = {
  root: clothingRoot,
  materialDomain: item.materialDomain || "fabric"
};
}
function getFirstSkinnedMesh(root) {
  let found = null;
  root.traverse(obj => {
    if (obj.isSkinnedMesh && !found) {
      found = obj;
    }
  });
  return found;
}
function unequipClothing(category) {
  const id = equippedClothes[category];
  if (!id) return;

  const data = loadedClothingMeshes[id];
  if (!data || !data.root) return;

  const root = data.root;

  if (root.parent === currentModel) {
    currentModel.remove(root);
  }
// 🔑 REMOVE CLOTHING FROM BLENDSHAPE MAP
Object.keys(blendShapeMap).forEach(name => {
  blendShapeMap[name] = blendShapeMap[name].filter(
    entry => entry.mesh.parent !== root
  );

  if (blendShapeMap[name].length === 0) {
    delete blendShapeMap[name];
  }
});

  root.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => m?.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });

  delete loadedClothingMeshes[id];
  equippedClothes[category] = null;

  rebuildMaterialTargets();
  syncMaterialUI();
  buildTextureGrid();
}
function resetClothingUI() {
  clothesItemsGrid.innerHTML = `
    <div class="clothes-placeholder">
      Select a category
    </div>
  `;
  clothesItemsTitle.textContent = "Select a category";

  document
    .querySelectorAll(".clothes-category")
    .forEach(b => b.classList.remove("active"));
}
function unequipAllClothes() {
  if (!currentModel) return;

  Object.entries(loadedClothingMeshes).forEach(([id, data]) => {
    if (!data || !data.root || !data.root.isObject3D) return;

    const root = data.root;

    if (root.parent === currentModel) {
      currentModel.remove(root);
    }

    root.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();

      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m?.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  });

  loadedClothingMeshes = {};

  equippedClothes = {
    shirt: null,
    pants: null,
    gloves: null,
    shoes: null,
    hair: null,
    jacket: null,
    facialHair: null,
    headwear: null,
    glasses: null,
    accessories: null
  };

  rebuildMaterialTargets();
  syncMaterialUI();
  buildTextureGrid();
}


/* ---------------- EXPORT UI ---------------- */
const exportBtn = document.getElementById("export-btn");
const exportMenu = document.getElementById("export-menu");
exportBtn.addEventListener("click", () => {
  exportMenu.classList.toggle("active");
});
document.querySelectorAll(".export-option").forEach(btn => {
  btn.addEventListener("click", () => {
    const format = btn.dataset.format; // "glb" or "gltf"
    exportCharacter(format);
    exportMenu.classList.remove("active");
  });
});
function exportCharacter(format = "glb") {
  if (!currentModel) {
    alert("No character to export");
    return;
  }

  const exporter = new GLTFExporter();

  // Ensure morph values are baked
  currentModel.traverse(obj => {
    if (obj.isSkinnedMesh && obj.morphTargetInfluences) {
      obj.morphTargetInfluences = obj.morphTargetInfluences.map(v => v);
    }
  });

const options = {
  binary: format === "glb",
  trs: false,
  onlyVisible: true,
  embedImages: true,
  includeCustomExtensions: true,
  animations: activeAction ? [activeAction.getClip()] : []
};


  exporter.parse(
    currentModel,
    result => {
      let blob;
      let filename = `morphara_${currentBaseMesh?.id || "character"}.${format}`;

      if (format === "glb") {
        blob = new Blob([result], {
          type: "model/gltf-binary"
        });
      } else {
        // GLTF with embedded base64 textures
        blob = new Blob(
          [JSON.stringify(result, null, 2)],
          { type: "application/json" }
        );
      }

      downloadBlob(blob, filename);
    },
    error => {
      console.error("Export error:", error);
    },
    options
  );
}
function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}
/* ---------------- LOOP ---------------- */
function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.033);
  if (mixer) mixer.update(delta);

  applyMorphsPerFrame();
  controls.update();
  renderer.render(scene, camera);
}
/* ---------------- MATERIALS ---------------- */
const textureLoader = new THREE.TextureLoader();
const baseColorPicker = document.getElementById("baseColorPicker");
const textureGrid = document.getElementById("texture-grid");
const materialTargetsContainer = document.getElementById("material-targets");
function applyTexturePreset(preset) {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  target.materialState.texture = preset;

  target.meshes.forEach(mesh => {
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    mats.forEach(mat => {
      if (!mat) return;

      // Base color / map
      if (preset.map) {
        mat.map = textureLoader.load(preset.map);
        mat.map.colorSpace = THREE.SRGBColorSpace;
      } else {
        mat.map = null;
      }

      // Optional PBR extras (future-safe)
      if (preset.normal) {
        mat.normalMap = textureLoader.load(preset.normal);
      }

      if (preset.roughness !== undefined) {
        mat.roughness = preset.roughness;
      }

      if (preset.metalness !== undefined) {
        mat.metalness = preset.metalness;
      }

      mat.needsUpdate = true;
    });
  });
}

if (baseColorPicker) {
baseColorPicker.addEventListener("input", e => {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  const color = new THREE.Color(e.target.value);
  target.materialState.color = color;

  target.meshes.forEach(mesh => {
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    mats.forEach(mat => mat?.color?.copy(color));
  });
});

}
function rebuildMaterialTargetsUI() {
  materialTargetsContainer.innerHTML = "";

  Object.entries(materialTargets).forEach(([key, target]) => {
    const btn = document.createElement("button");
    btn.className = "material-target-btn";
    btn.textContent = target.label;

    if (key === activeMaterialTarget) {
      btn.classList.add("active");
    }

    btn.onclick = () => {
      activeMaterialTarget = key;
      rebuildMaterialTargetsUI();
      syncMaterialUI();
      buildTextureGrid();
    };

    materialTargetsContainer.appendChild(btn);
  });
}

function rebuildMaterialTargets() {
  materialTargets = {};

  // Base mesh → skin
  if (baseSkinnedMeshes.length) {
    materialTargets.base = {
      label: "Skin",
      meshes: baseSkinnedMeshes,
      domain: "skin",
      materialState: {
        color: new THREE.Color("#ffffff"),
        texture: null
      }
    };
  }

  // Clothes
Object.entries(loadedClothingMeshes).forEach(([id, data]) => {
  const { root, materialDomain } = data;

  const meshes = [];
  root.traverse(o => o.isSkinnedMesh && meshes.push(o));
  if (!meshes.length) return;

  materialTargets[id] = {
    label: id,
    meshes,
    domain: materialDomain || "fabric", // 🔑 NOW DYNAMIC
    materialState: {
      color: new THREE.Color("#ffffff"),
      texture: null
    }
  };
});


  if (!activeMaterialTarget || !materialTargets[activeMaterialTarget]) {
    activeMaterialTarget = Object.keys(materialTargets)[0] || null;
  }
}

function syncMaterialUI() {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;
  baseColorPicker.value = `#${target.materialState.color.getHexString()}`;
}
function buildTextureGrid() {
  textureGrid.innerHTML = "";

  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  const presets = TEXTURE_PRESETS[target.domain] || [];

  if (!presets.length) {
    textureGrid.innerHTML = `
      <div style="color:#777;font-size:12px;">
        No presets for this material
      </div>
    `;
    return;
  }

  presets.forEach(preset => {
    const item = document.createElement("div");
    item.className = "texture-item";
    item.title = preset.label;

    if (preset.map) {
      item.style.backgroundImage = `url(${preset.map})`;
    } else {
      item.innerText = "Flat";
    }

    item.onclick = () => applyTexturePreset(preset);

    textureGrid.appendChild(item);
  });
}
/* ---------------- Randomisation Configartion ---------------- */
document.querySelectorAll('[data-rand]').forEach(input => {
  const key = input.dataset.rand;
  input.addEventListener('change', () => {
    randomizerConfig[key] = input.checked;
  });
});
document.getElementById('randomize-btn')
  .addEventListener('click', randomizeCharacter);

document.getElementById('reset-btn')
  .addEventListener('click', resetCharacter);

function updateResetButton() {
  const resetBtn = document.getElementById('reset-btn');
  if (!resetBtn) return;
  resetBtn.disabled = !currentBaseMesh;
}
function randomizeCharacter() {

  /* ---------- BASE MESH ---------- */
  if (randomizerConfig.baseMesh) {
    const mesh =
      BASE_MESHES[Math.floor(Math.random() * BASE_MESHES.length)];
    loadBaseMesh(mesh);
    return; // wait for model to load, next click continues
  }

  if (!currentBaseMesh) return;

  /* ---------- CLOTHES ---------- */
  if (randomizerConfig.clothes) {
    unequipAllClothes();

    const categories = [...new Set(CLOTHES.map(c => c.category))];

    categories.forEach(category => {
      if (Math.random() > 0.5) return;

      const items = CLOTHES.filter(
        c => c.baseMesh === currentBaseMesh.id &&
             c.category === category
      );

      if (!items.length) return;

      const item = items[Math.floor(Math.random() * items.length)];
      equipClothing(item);
    });
  }

  /* ---------- BLEND SHAPES ---------- */
  if (randomizerConfig.blendShapes) {
    Object.keys(morphValues).forEach(key => {
      morphValues[key] = Math.random() * 0.6;
    });
  }

  /* ---------- MATERIALS ---------- */
  Object.entries(materialTargets).forEach(([key, target]) => {
    activeMaterialTarget = key;

    if (randomizerConfig.colors) {
      target.materialState.color.setHSL(
        Math.random(),
        0.4 + Math.random() * 0.3,
        0.4 + Math.random() * 0.3
      );
    }

    if (randomizerConfig.textures) {
      const presets = TEXTURE_PRESETS[target.domain];
      if (presets?.length) {
        const preset =
          presets[Math.floor(Math.random() * presets.length)];
        applyTexturePreset(preset);
      }
    }
  });

  /* ---------- ANIMATION ---------- */
  if (randomizerConfig.animation) {
    const anims = ANIMATIONS.filter(
      a => a.baseMesh === currentBaseMesh.id
    );

    if (anims.length) {
      loadAnimation(
        anims[Math.floor(Math.random() * anims.length)]
      );
    }
  }
}
function resetCharacter() {
  if (!currentBaseMesh) return;

  unequipAllClothes();

  /* ---------- RESET BLEND SHAPES ---------- */
  Object.keys(morphValues).forEach(k => {
    morphValues[k] = 0;
  });

  /* ---------- RESET ANIMATION ---------- */
  if (mixer) {
    mixer.stopAllAction();
    activeAction = null;
  }

  /* ---------- RESET SKIN ---------- */
  rebuildMaterialTargets();
  activeMaterialTarget = "base";

  const skinPresets = TEXTURE_PRESETS.skin || [];
  const warm = skinPresets.find(p => p.id === "skin_warm");

  if (warm) {
    applyTexturePreset(warm);
  }

  syncMaterialUI();
  buildTextureGrid();
}


/* ---------------- ANIMATION UI ---------------- */
const animationsList = document.getElementById("animations-list");
function buildAnimationUI() {
  animationsList.innerHTML = "";

  if (!currentBaseMesh) {
    animationsList.innerHTML = "<p style='color:#888'>Select a base mesh first</p>";
    return;
  }

  const items = ANIMATIONS.filter(
    a => a.baseMesh === currentBaseMesh.id
  );

  items.forEach(anim => {
    const card = document.createElement("div");
    card.className = "base-mesh-card";

    const preview = document.createElement("div");
    preview.className = "preview-canvas";

    const label = document.createElement("div");
    label.className = "base-mesh-name";
    label.textContent = anim.name;

    card.append(preview, label);
    animationsList.appendChild(card);

createPreview({
  container: preview,
  animationPath: anim.path,
  baseMeshId: anim.baseMesh,
  autoRotate: false
});


    card.onclick = () => loadAnimation(anim);
  });
}

async function loadAnimation(animData) {
  if (!currentModel) return;

  const gltf = await loader.loadAsync(animData.path);
  if (!gltf.animations.length) return;

  if (!mixer) {
    mixer = new THREE.AnimationMixer(currentModel);
  }

  // 🔑 HARD STOP ALL PREVIOUS ACTIONS
  mixer.stopAllAction();

  activeAction = mixer.clipAction(gltf.animations[0]);

  activeAction.reset();
  activeAction.setEffectiveWeight(1);
  activeAction.setEffectiveTimeScale(1);

  activeAction.loop = animData.loop
    ? THREE.LoopRepeat
    : THREE.LoopOnce;

  activeAction.play();
}

/* ---------------- SCENE HELPERS ---------------- */
function addGroundGrid() {
  scene.add(new THREE.GridHelper(10, 20, 0x444444, 0x222222));
}
function setupLights() {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-5, 5, -5);
  scene.add(fill);
}
function setupControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.2;
controls.maxDistance = 6;
}
/* ---------------- CAMERA ---------------- */
function frameCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);

  const size = box.getSize(new THREE.Vector3());
  const height = size.y;

  const center = box.getCenter(new THREE.Vector3());

  // Character-focused target (upper body)
  const targetY = box.min.y + height * 0.6;

  const target = new THREE.Vector3(
    center.x,
    targetY,
    center.z
  );

  const distance = height * 8;

  // 📸 Camera in FRONT of character, slightly above, tilted down
  camera.position.set(
    center.x,
    targetY + height * 7, // height gives downward angle
    center.z - distance      // FRONT (important)
  );

  controls.target.copy(target);
  controls.update();

  camera.lookAt(target);
}

function framePainterCamera() {
  if (!currentModel) return;

  const box = new THREE.Box3().setFromObject(currentModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const height = size.y;

  const target = new THREE.Vector3(
    center.x,
    center.y + height * 0.55,
    center.z
  );

  camera.position.set(
    center.x,
    target.y + height * 7,
    center.z - height * 10
  );

  controls.target.copy(target);
  controls.update();
}

function onResize() {
  let width, height;

  if (isPainterMode) {
    const rect = document
      .getElementById("painter-viewport")
      .getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  } else {
    const viewport = document.getElementById("viewport");
    width = viewport.clientWidth;
    height = viewport.clientHeight;
  }

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

/* ================= Texture Painter Mode ================= */
const painterMode = document.getElementById("texture-painter-mode");
const painterViewport = document.getElementById("painter-viewport");
const exitPainterBtn = document.getElementById("exit-painter");

let previousUIMode = "materials";

function enterPainterMode() {
  if (!currentModel || !activeMaterialTarget) return;
  isPainterMode = true;

  // remember where we came from
  const activeBtn = document.querySelector(".top-btn.active");
  previousUIMode = activeBtn?.dataset.mode || "materials";

  // hide customization UI (CLASS-BASED, not style)
  document.getElementById("top-panel").classList.add("hidden");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("clothes-items-panel")?.classList.remove("active");

  // show painter
  painterMode.classList.remove("hidden");

  // move renderer
  originalViewportParent = renderer.domElement.parentElement;
  painterViewport.appendChild(renderer.domElement);

  framePainterCamera();
  onResize();
}
function exitPainterMode() {
    if (texturePainter) {
    texturePainter = null;
  }

  painterTargetMesh = null;
  painterCanvas = null;
  isPainterMode = false;

  // restore renderer
  if (originalViewportParent) {
    originalViewportParent.appendChild(renderer.domElement);
  }

  painterMode.classList.add("hidden");

  // restore UI (NO inline styles)
  document.getElementById("top-panel").classList.remove("hidden");

  // restore previous mode cleanly
  setUIMode(previousUIMode);

  onResize();
}
document
  .getElementById("open-texture-painter")
  .addEventListener("click", () => {

    const target = materialTargets[activeMaterialTarget];
    if (!target) {
      alert("No material selected");
      return;
    }

    // FIRST mesh of the material target
    painterTargetMesh = target.meshes[0];
    if (!painterTargetMesh) {
      alert("No mesh found for this material");
      return;
    }

    const material = painterTargetMesh.material;
    if (!material) {
      alert("Mesh has no material");
      return;
    }

    const key = activeMaterialTarget;

    // ---------------------------------------
    // CREATE OR RESTORE PAINT DATA PER TARGET
    // ---------------------------------------

    if (!paintedTextures[key]) {
      // Create OFFSCREEN canvas (REAL texture)
      const offscreenCanvas = document.createElement("canvas");
      const PAINT_RESOLUTION = 1024;
      offscreenCanvas.width = PAINT_RESOLUTION;
      offscreenCanvas.height = PAINT_RESOLUTION;

      const ctx = offscreenCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);


      // If material already has a texture, copy it ONCE
      if (material.map?.image) {
        try {
          ctx.drawImage(
            material.map.image,
            0,
            0,
            offscreenCanvas.width,
            offscreenCanvas.height
          );
        } catch (e) {
          // ignore CORS or image errors
        }
      }

      const texture = new THREE.CanvasTexture(offscreenCanvas);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      paintedTextures[key] = {
        canvas: offscreenCanvas,
        texture
      };

      material.map = texture;
      material.needsUpdate = true;
      showToast("Painter texture re-applied");
    }

    // ---------------------------------------
    // RESTORE STORED CANVAS + TEXTURE
    // ---------------------------------------

    const { canvas: storedCanvas, texture } = paintedTextures[key];

    material.map = texture;
    material.needsUpdate = true;
    painterCanvas = storedCanvas;

    // ---------------------------------------
    // CREATE PAINTER (NO TEXTURE OWNERSHIP)
    // ---------------------------------------

    texturePainter = new TexturePainter({
      canvas: painterCanvas,
      mesh: painterTargetMesh,
      material,
      texture
    });

    // ---------------------------------------
    // SETUP CANVAS DRAW EVENTS (ONCE)
    // ---------------------------------------

    const uiCanvas = document.getElementById("texture-canvas");

    // sync UI canvas size
    uiCanvas.width = painterCanvas.width;
    uiCanvas.height = painterCanvas.height;

    let isPaintingLocal = false;

uiCanvas.onpointerdown = e => {
  const { x, y } = getTextureCoordsFromMouse(e, uiCanvas);

  isPaintingLocal = true;
  texturePainter.startDraw(x, y);
};


uiCanvas.onpointermove = e => {
  if (!isPaintingLocal) return;

  const { x, y } = getTextureCoordsFromMouse(e, uiCanvas);
  texturePainter.draw(x, y);
  updateTextureView();
};


    window.onpointerup = () => {
      if (!isPaintingLocal) return;
      isPaintingLocal = false;
      texturePainter.endDraw();
    };
    texZoom = 1;
    texOffsetX = 0;
    texOffsetY = 0;
// ---------------------------------------
// LOAD UV OVERLAY (LOCKED PREVIEW)
// ---------------------------------------

uvOverlayImage = null;

const uvPath = getUVMapForActiveTarget();
if (uvPath) {
const img = new Image();
img.crossOrigin = "anonymous";
img.src = uvPath + "?v=" + Date.now();
img.onload = () => {
  uvOverlayImage = img;
  updateTextureView();
};

}
  showUVOverlay = true;
  toggleUVBtn.classList.toggle("active", showUVOverlay);
  uvOpacitySlider.value = uvOpacity ;
    enterPainterMode();
    updateTextureView();
    texturePainter.setTool("draw");

document.querySelectorAll(".tool-btn").forEach(b =>
  b.classList.toggle("active", b.dataset.tool === "draw")
);

  });


exitPainterBtn.addEventListener("click", exitPainterMode);
/* ================= Texture Painter Logic ================= */
let texZoom = 1;
let texOffsetX = 0;
let texOffsetY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;

document.querySelectorAll(".tool-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!texturePainter) return;

    const tool = btn.dataset.tool;

    // UI active state
    document
      .querySelectorAll(".tool-btn")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Tell painter
    texturePainter.setTool(tool);
  });
});
const paintColorInput = document.getElementById("paint-color");
paintColorInput.addEventListener("input", e => {
  if (!texturePainter) return;
  texturePainter.setColor(e.target.value);
});
const brushSizeInput = document.getElementById("brush-size");
brushSizeInput.addEventListener("input", e => {
  if (!texturePainter) return;
  texturePainter.setBrushSize(parseInt(e.target.value, 10));
});
function updateTextureView() {
  // UI canvas (the visible one on the right)
  const uiCanvas = document.getElementById("texture-canvas");
  if (!uiCanvas) return;

  const uiCtx = uiCanvas.getContext("2d");

  // Offscreen canvas (the real texture data)
  if (!painterCanvas) return;

  // Ensure UI canvas matches texture resolution
  if (
    uiCanvas.width !== painterCanvas.width ||
    uiCanvas.height !== painterCanvas.height
  ) {
    uiCanvas.width = painterCanvas.width;
    uiCanvas.height = painterCanvas.height;
  }

  // Clear preview
  uiCtx.setTransform(1, 0, 0, 1, 0, 0);
  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);

  // Apply pan + zoom (PREVIEW ONLY)
  uiCtx.translate(
    uiCanvas.width / 2 + texOffsetX,
    uiCanvas.height / 2 + texOffsetY
  );
  uiCtx.scale(texZoom, texZoom);
  uiCtx.translate(
    -painterCanvas.width / 2,
    -painterCanvas.height / 2
  );

  // Draw texture preview
  uiCtx.drawImage(painterCanvas, 0, 0);
  // ---------------------------------------
// UV OVERLAY (PREVIEW ONLY, LOCKED)
// ---------------------------------------
if (showUVOverlay && uvOverlayImage) {
  uiCtx.save();

  uiCtx.globalAlpha = uvOpacity; // adjust opacity here
  uiCtx.drawImage(
    uvOverlayImage,
    0,
    0,
    painterCanvas.width,
    painterCanvas.height
  );

  uiCtx.restore();
}
}
function getTextureCoordsFromMouse(e, uiCanvas) {
  const rect = uiCanvas.getBoundingClientRect();

  // Mouse position in UI canvas space
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  // Move origin to canvas center
  let x = mx - uiCanvas.width / 2;
  let y = my - uiCanvas.height / 2;

  // Undo pan
  x -= texOffsetX;
  y -= texOffsetY;

  // Undo zoom
  x /= texZoom;
  y /= texZoom;

  // Move origin to texture space
  x += painterCanvas.width / 2;
  y += painterCanvas.height / 2;

  return { x, y };
}

const uiCanvas = document.getElementById("texture-canvas");

uiCanvas.addEventListener("wheel", e => {
  e.preventDefault();

  texZoom += e.deltaY * -0.001;
  texZoom = Math.min(Math.max(0.25, texZoom), 8);

  updateTextureView();
});

uiCanvas.addEventListener("pointerdown", e => {
  if (e.button !== 1 && e.button !== 2) return;

  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  uiCanvas.style.cursor = "grabbing";
});

window.addEventListener("pointermove", e => {
  if (!isPanning) return;

  texOffsetX += e.clientX - panStartX;
  texOffsetY += e.clientY - panStartY;

  panStartX = e.clientX;
  panStartY = e.clientY;

  updateTextureView();
});

window.addEventListener("pointerup", () => {
  isPanning = false;
  uiCanvas.style.cursor = "grab";
});

function showToast(message, duration = 1500) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.add("show");

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, duration);
}
/* ------------------ UV MAPS ---------- */
function getUVMapForActiveTarget() {
  // Clothes UV
  const clothing = CLOTHES.find(c => c.id === activeMaterialTarget);
  if (clothing?.uvMap) {
    return clothing.uvMap;
  }

  // Base mesh UV
  if (currentBaseMesh?.id) {
    const base = BASE_MESHES.find(b => b.id === currentBaseMesh.id);
    if (base?.uvMap) {
      return base.uvMap;
    }
  }

  return null;
}

const toggleUVBtn = document.getElementById("toggle-uv");
const uvOpacitySlider = document.getElementById("uv-opacity");
toggleUVBtn.onclick = () => {
  showUVOverlay = !showUVOverlay;
  toggleUVBtn.classList.toggle("active", showUVOverlay);
  updateTextureView();
};
uvOpacitySlider.oninput = e => {
  uvOpacity = parseInt(e.target.value, 10) / 100;
  updateTextureView();
};
/* ---------------- User Menus ---------------- */
/* ---------------- User & Credits Menus ---------------- */

const userBtn = document.getElementById("user-btn");
const creditsBtn = document.getElementById("credits-btn");

const userMenu = document.getElementById("user-menu");
const creditsMenu = document.getElementById("credits-menu");

userBtn.onclick = (e) => {
  e.stopPropagation();
  userMenu.classList.toggle("hidden");
  creditsMenu.classList.add("hidden");
};

creditsBtn.onclick = (e) => {
  e.stopPropagation();
  creditsMenu.classList.toggle("hidden");
  userMenu.classList.add("hidden");
};

document.addEventListener("click", () => {
  userMenu.classList.add("hidden");
  creditsMenu.classList.add("hidden");
});

[userMenu, creditsMenu].forEach(menu => {
  menu.addEventListener("click", e => e.stopPropagation());
});
/* ================= Launch Overlay ================= */

/* ================= Launch Overlay ================= */

const launchOverlay = document.getElementById("launch-overlay");
const closeLaunch = document.getElementById("close-launch");
const launchCTA = document.querySelector("#launch-overlay .open-plans");

if (launchOverlay && closeLaunch) {

  const hasSeenLaunch = localStorage.getItem("morphara_launch_seen");

  if (hasSeenLaunch) {
    launchOverlay.style.display = "none";
  }

  function closeLaunchOverlay() {
    launchOverlay.style.display = "none";
    localStorage.setItem("morphara_launch_seen", "true");
  }

  closeLaunch.addEventListener("click", closeLaunchOverlay);
  
  if (launchCTA) {
    launchCTA.addEventListener("click", () => {
      closeLaunchOverlay();

      // Open plans overlay manually
      const plansOverlay = document.getElementById("plans-overlay");
      if (plansOverlay) {
        plansOverlay.classList.remove("hidden");
        document.body.style.overflow = "hidden";
      }
    });
  }
}
