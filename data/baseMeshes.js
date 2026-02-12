// data/baseMeshes.js
// Base Mesh Registry for Morphara v0.0.5
// Each entry represents a FULL character model (one mesh / one GLB)

export const BASE_MESHES = [
  {
    id: "lowpoly_male",
    name: "Low Poly Male",
    style: "lowpoly",
    gender: "male",
    path: "./Assets/BaseMeshes/lowpoly_male.glb",
    uvMap: "./Assets/uvMaps/lowpoly_male.png"
  },
  {
    id: "midpoly_male",
    name: "Mid Poly Male",
    style: "midpoly",
    gender: "male",
    path: "./Assets/BaseMeshes/midpoly_male.glb",
    uvMap: "./Assets/uvMaps/midpoly_male.png"
  },
//   {
//     id: "stylized_male",
//     name: "Stylized Male",
//     style: "stylized",
//     gender: "male",
//     path: "./Assets/BaseMeshes/stylized_male.glb"
//   }
];

// Helper (optional later)
export function getBaseMeshById(id) {
  return BASE_MESHES.find(m => m.id === id);
}
