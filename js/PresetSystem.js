





import * as THREE from "three";

export class PresetSystem {
  constructor({ supabase }) {
    this.supabase = supabase;
    this.officialPresets = [];
    this.userPresets = [];
    this.currentPreset = null;


    this.modalOverlay = null;
    this.presetGrid = null;
    this.currentTab = 'official';
  }





  initUI() {
    this.modalOverlay = document.getElementById('preset-modal-overlay');
    this.presetGrid = document.getElementById('preset-grid');

    this.attachEventListeners();
  }

  attachEventListeners() {

    document.getElementById('preset-close-btn')?.addEventListener('click', () => {
      this.hideModal();
    });


    this.modalOverlay?.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) {
        this.hideModal();
      }
    });


    document.querySelectorAll('.preset-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTab(tab.dataset.tab);
      });
    });


    document.getElementById('preset-category-filter')?.addEventListener('change', (e) => {
      this.filterByCategory(e.target.value);
    });


    let searchTimeout;
    document.getElementById('preset-search-input')?.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.searchPresets(e.target.value);
      }, 300);
    });


    document.getElementById('start-scratch-btn')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('preset-start-scratch'));
      this.hideModal();
    });


    document.getElementById('save-preset-btn')?.addEventListener('click', () => {
      this.openSaveDialog();
    });

    document.getElementById('save-official-btn')?.addEventListener('click', () => {
      this.openSaveOfficialDialog();
    });
  }





  captureState(appState) {
    const {
      currentBaseMesh,
      morphValues,
      equippedClothes,
      loadedClothingMeshes,
      materialTargets,
    } = appState;

    if (!currentBaseMesh) {
      throw new Error("No base mesh loaded");
    }

    const config = {
      version: "1.0",
      baseMesh: {
        id: currentBaseMesh.id,
        r2Key: currentBaseMesh.r2Key,
        name: currentBaseMesh.name
      },
      blendShapes: { ...morphValues },
      clothing: {},
      textures: {},
      colors: {},
      materials: {}
    };


    Object.entries(equippedClothes).forEach(([category, itemId]) => {
      if (itemId && loadedClothingMeshes[itemId]) {
        const clothingData = loadedClothingMeshes[itemId];

        const clothingItem = clothingData.clothing || clothingData;

        config.clothing[category] = {
          id: itemId,
          r2Key: clothingItem.r2Key,
          name: clothingItem.name,
          category: category
        };
      } else {
        config.clothing[category] = null;
      }
    });


    Object.entries(materialTargets).forEach(([key, target]) => {

      if (target.materialState?.texture) {
        const tex = target.materialState.texture;
        config.textures[key] = {
          id: tex.id,
          r2Key: tex.r2Key || tex.r2key,
          name: tex.label || tex.name,
          material_domain: tex.material_domain
        };
      }


      if (target.materialState?.color) {
        config.colors[key] = `#${target.materialState.color.getHexString()}`;
      }


      if (target.meshes?.[0]?.material) {
        const mat = Array.isArray(target.meshes[0].material)
          ? target.meshes[0].material[0]
          : target.meshes[0].material;

        config.materials[key] = {
          roughness: mat.roughness ?? 0.5,
          metalness: mat.metalness ?? 0.0
        };
      }
    });

    return config;
  }





  async saveAsUserPreset(config, metadata) {
    try {
      const { data: { session } } = await this.supabase.auth.getSession();
      if (!session) {
        throw new Error("Must be logged in to save presets");
      }

      const { data, error } = await this.supabase
        .from('user_presets')
        .insert({
          user_id: session.user.id,
          name: metadata.name,
          description: metadata.description || null,
          thumbnail: metadata.thumbnail || null,
          tags: metadata.tags || [],
          config: config,
          is_public: metadata.isPublic || false
        })
        .select()
        .single();

      if (error) throw error;

      this.userPresets.push(data);
      return { success: true, preset: data };

    } catch (error) {
      console.error('Failed to save preset:', error);
      return { success: false, error: error.message };
    }
  }

  async saveAsOfficialPreset(config, metadata) {
    try {
      const { data, error } = await this.supabase
        .from('official_presets')
        .insert({
          name: metadata.name,
          description: metadata.description || null,
          thumbnail: metadata.thumbnail || null,
          category: metadata.category || 'casual',
          tags: metadata.tags || [],
          config: config,
          difficulty: metadata.difficulty || 'easy',
          sort_order: metadata.sortOrder || 0,
          is_active: true
        })
        .select()
        .single();

      if (error) throw error;

      this.officialPresets.push(data);
      return { success: true, preset: data };

    } catch (error) {
      console.error('Failed to save official preset:', error);
      return { success: false, error: error.message };
    }
  }

  async updateUserPreset(presetId, updates) {
    try {
      const { data, error } = await this.supabase
        .from('user_presets')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', presetId)
        .select()
        .single();

      if (error) throw error;

      const index = this.userPresets.findIndex(p => p.id === presetId);
      if (index >= 0) this.userPresets[index] = data;

      return { success: true, preset: data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteUserPreset(presetId) {
    try {
      const { error } = await this.supabase
        .from('user_presets')
        .delete()
        .eq('id', presetId);

      if (error) throw error;

      this.userPresets = this.userPresets.filter(p => p.id !== presetId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }





  async loadOfficialPresets(filters = {}) {
    try {
      let query = this.supabase
        .from('official_presets')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('popularity', { ascending: false })
        .limit(filters.limit || 50);

      if (filters.category && filters.category !== 'all') {
        query = query.eq('category', filters.category);
      }

      const { data, error } = await query;
      if (error) throw error;

      this.officialPresets = data || [];
      return { success: true, presets: this.officialPresets };
    } catch (error) {
      console.error('Failed to load official presets:', error);
      return { success: false, error: error.message };
    }
  }

  async loadUserPresets() {
    try {
      const { data: { session } } = await this.supabase.auth.getSession();
      if (!session) return { success: true, presets: [] };

      const { data, error } = await this.supabase
        .from('user_presets')
        .select('*')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      this.userPresets = data || [];
      return { success: true, presets: this.userPresets };
    } catch (error) {
      console.error('Failed to load user presets:', error);
      return { success: false, error: error.message };
    }
  }

  async loadCommunityPresets(filters = {}) {
    try {
      let query = this.supabase
        .from('user_presets')
        .select('*')
        .eq('is_public', true)
        .limit(filters.limit || 50);

      if (filters.sortBy === 'likes') {
        query = query.order('likes_count', { ascending: false });
      } else {
        query = query.order('created_at', { ascending: false });
      }

      const { data, error } = await query;
      if (error) throw error;

      return { success: true, presets: data || [] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }





  async applyPreset(preset, loadFunctions) {
    try {
      this.currentPreset = preset;
      const config = preset.config;


      if (preset.id && !preset.user_id) {
        this.supabase.rpc('increment_preset_popularity', { preset_id: preset.id }).then();
      }


      const instructions = {
        baseMesh: config.baseMesh,
        blendShapes: config.blendShapes || {},
        clothing: [],
        textures: [],
        colors: config.colors || {},
        materials: config.materials || {}
      };


      Object.entries(config.clothing || {}).forEach(([category, item]) => {
        if (item) {
          instructions.clothing.push({
            category,
            id: item.id,
            r2Key: item.r2Key,
            name: item.name
          });
        }
      });


      Object.entries(config.textures || {}).forEach(([materialKey, texture]) => {
        if (texture) {
          instructions.textures.push({
            materialKey,
            id: texture.id,
            r2Key: texture.r2Key,
            name: texture.name,
            material_domain: texture.material_domain
          });
        }
      });

      return instructions;

    } catch (error) {
      console.error('Failed to apply preset:', error);
      throw error;
    }
  }





  showModal() {
    if (!this.modalOverlay) return;
    this.modalOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';


    if (this.currentTab !== 'scratch') {
      this.loadPresetsForCurrentTab();
    }
  }

  hideModal() {
    if (!this.modalOverlay) return;
    this.modalOverlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  switchTab(tab) {
    this.currentTab = tab;


    document.querySelectorAll('.preset-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });


    const filters = document.getElementById('preset-filters');
    const footer = document.getElementById('preset-footer');
    const grid = document.getElementById('preset-grid-container');

    if (tab === 'scratch') {
      filters?.classList.add('hidden');
      footer?.classList.remove('hidden');
      grid?.classList.add('hidden');
    } else {
      filters?.classList.remove('hidden');
      footer?.classList.add('hidden');
      grid?.classList.remove('hidden');
      this.loadPresetsForCurrentTab();
    }
  }

  async loadPresetsForCurrentTab() {
    const grid = document.getElementById('preset-grid');
    if (!grid) return;

    grid.innerHTML = '<div class="preset-loading">Loading presets...</div>';

    let result;
    if (this.currentTab === 'official') {
      const category = document.getElementById('preset-category-filter')?.value;
      result = await this.loadOfficialPresets({ category });
    } else if (this.currentTab === 'user') {
      result = await this.loadUserPresets();
    } else if (this.currentTab === 'community') {
      result = await this.loadCommunityPresets({ sortBy: 'likes' });
    }

    if (!result.success) {
      grid.innerHTML = '<div class="preset-error">Failed to load presets</div>';
      return;
    }

    this.renderPresets(result.presets);
  }

  renderPresets(presets) {
    const grid = document.getElementById('preset-grid');
    if (!grid) return;

    if (!presets || presets.length === 0) {
      grid.innerHTML = `
        <div class="preset-empty">
          <p>No presets found</p>
          ${this.currentTab === 'user' ? '<p>Save your first character to see it here!</p>' : ''}
        </div>
      `;
      return;
    }

    grid.innerHTML = '';
    presets.forEach(preset => {
      const card = this.createPresetCard(preset);
      grid.appendChild(card);
    });
  }

  createPresetCard(preset) {
    const card = document.createElement('div');
    card.className = 'preset-card';


    const thumbnail = document.createElement('div');
    thumbnail.className = 'preset-thumbnail';
    if (preset.thumbnail) {
      thumbnail.style.backgroundImage = `url(${preset.thumbnail})`;
    } else {
      thumbnail.innerHTML = '<div class="preset-no-image">No Preview</div>';
    }


    if (preset.is_premium) {
      const badge = document.createElement('div');
      badge.className = 'preset-premium-badge';
      badge.textContent = '⭐ Premium';
      thumbnail.appendChild(badge);
    }


    const info = document.createElement('div');
    info.className = 'preset-info';

    const name = document.createElement('div');
    name.className = 'preset-name';
    name.textContent = preset.name;
    info.appendChild(name);

    if (preset.description) {
      const desc = document.createElement('div');
      desc.className = 'preset-description';
      desc.textContent = preset.description;
      info.appendChild(desc);
    }


    if (preset.tags && preset.tags.length > 0) {
      const tags = document.createElement('div');
      tags.className = 'preset-tags';
      preset.tags.slice(0, 3).forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'preset-tag';
        tagEl.textContent = tag;
        tags.appendChild(tagEl);
      });
      info.appendChild(tags);
    }


    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'preset-btn-load';
    loadBtn.textContent = 'Load Preset';
    loadBtn.onclick = () => {
      window.dispatchEvent(new CustomEvent('preset-load', { detail: preset }));
      this.hideModal();
    };
    actions.appendChild(loadBtn);


    if (this.currentTab === 'user') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'preset-btn-delete';
      deleteBtn.textContent = '🗑️';
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm('Delete this preset?')) {
          const result = await this.deleteUserPreset(preset.id);
          if (result.success) {
            card.remove();
          }
        }
      };
      actions.appendChild(deleteBtn);
    }

    card.appendChild(thumbnail);
    card.appendChild(info);
    card.appendChild(actions);

    return card;
  }

  filterByCategory(category) {
    if (this.currentTab === 'official') {
      this.loadOfficialPresets({ category });
    }
  }

  searchPresets(term) {
    const cards = document.querySelectorAll('.preset-card');
    const lowerTerm = term.toLowerCase();

    cards.forEach(card => {
      const name = card.querySelector('.preset-name')?.textContent.toLowerCase() || '';
      const desc = card.querySelector('.preset-description')?.textContent.toLowerCase() || '';
      const tags = Array.from(card.querySelectorAll('.preset-tag'))
        .map(t => t.textContent.toLowerCase())
        .join(' ');

      const matches = name.includes(lowerTerm) || desc.includes(lowerTerm) || tags.includes(lowerTerm);
      card.style.display = matches ? 'flex' : 'none';
    });
  }





  openSaveDialog() {
    const name = prompt("Enter preset name:");
    if (!name) return;

    const description = prompt("Enter description (optional):");

    window.dispatchEvent(new CustomEvent('preset-save-user', {
      detail: { name, description }
    }));
  }

  openSaveOfficialDialog() {
    const name = prompt("Enter preset name:");
    if (!name) return;

    const description = prompt("Enter description:");
    const category = prompt("Category (casual/sports/fantasy/etc):");
    const tagsStr = prompt("Tags (comma-separated):");
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];

    window.dispatchEvent(new CustomEvent('preset-save-official', {
      detail: { name, description, category, tags }
    }));
  }





  validateConfig(config) {
    if (!config.baseMesh) {
      return { valid: false, errors: ['Missing base mesh'] };
    }
    return { valid: true, errors: [] };
  }
}

export default PresetSystem;