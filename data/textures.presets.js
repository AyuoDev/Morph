// textures.presets.js
export const TEXTURE_PRESETS = {
  skin: [
    {
      id: "skin_flat",
      label: "Flat Skin",
      map: null
    },
    {
      id: "skin_warm",
      label: "Warm Skin",
      map: "./Assets/textures.presets/warm.jpg"
    }
  ],

  fabric: [
        {
      id: "fabric_flat",
      label: "Flat Fabric",
      map: null
    },
    {
      id: "fabric",
      label: "Fabric",
      map: "./Assets/textures.presets/fabric_albedo.jpg"
    },
    {
      id: "white_fabric",
      label: "White Fabric",
      map: "./Assets/textures.presets/white_fabric.jpg"
    },
    {
      id: "denim",
      label: "Denim",
      map: "./Assets/textures.presets/denim_albedo.jpg"
    }
  ],

  leather: [
        {
      id: "leather_flat",
      label: "Flat leather",
      map: null
    },
    {
      id: "leather",
      label: "Leather",
      map: "./Assets/textures.presets/leather_albedo.jpg"
    }
  ],

  metal: [
        {
      id: "metal_flat",
      label: "Flat metal",
      map: null
    },
    {
      id: "metal_steel",
      label: "Steel",
      map: "./Assets/textures.presets/steel_albedo.jpg",
      metalness: 1,
      roughness: 0.3
    }
  ],
    hair: [
    {
      id: "hair_basic",
      label: "Hair",
      map: "./Assets/textures.presets/hair/hair.png",
      metalness: 0,
      roughness: 0
    },
        {
      id: "hair_basic_2",
      label: "Hair 2",
      map: "./Assets/textures.presets/hair/hair2.png",
      metalness: 0,
      roughness: 0
    }
  ]
};
