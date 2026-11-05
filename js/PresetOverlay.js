





import { createPreview } from "./PreviewRenderer.js?v=20261105-preview-fix-2";
import * as THREE from "three";

export class PresetOverlay {
 constructor({
    supabase,
    onLoadPreset,
    onStartScratch,
    WORKER_URL,
    getAssetUrl,
    THREE,
    GLTFLoader
  }) {
    this.supabase = supabase;
    this.onLoadPreset = onLoadPreset;
    this.onStartScratch = onStartScratch;


    this.WORKER_URL = WORKER_URL;
    this.getAssetUrl = getAssetUrl;
    this.THREE = THREE;
    this.GLTFLoader = GLTFLoader;

    this.presets = [];
    this.currentPage = 0;
    this.presetsPerPage = 8;
    this.activePreviews = new Map();
    this.previewUrlPromises = new Map();
    this.previewGeneration = 0;

    this.overlay = null;
    this.carousel = null;
    this.leftArrow = null;
    this.rightArrow = null;
    this.indicators = null;
  }





  async init() {
    this.overlay = document.getElementById('preset-overlay');
    this.carousel = document.getElementById('preset-carousel');
    this.leftArrow = document.getElementById('preset-arrow-left');
    this.rightArrow = document.getElementById('preset-arrow-right');
    this.indicators = document.getElementById('preset-indicators');

    this.attachEventListeners();


    await this.loadPresets();


    const dontShow = localStorage.getItem('preset-dont-show');
    if (!dontShow) {
      this.show();
    } else {
      this.hide();
    }
  }

  attachEventListeners() {

    document.getElementById('close-preset-overlay')?.addEventListener('click', () => {
      this.hide();
    });


    this.leftArrow?.addEventListener('click', () => {
      this.previousPage();
    });

    this.rightArrow?.addEventListener('click', () => {
      this.nextPage();
    });


    document.getElementById('preset-scratch-btn')?.addEventListener('click', () => {
      this.hide();
      if (this.onStartScratch) {
        this.onStartScratch();
      }
    });


    document.getElementById('preset-dont-show')?.addEventListener('change', (e) => {
      if (e.target.checked) {
        localStorage.setItem('preset-dont-show', 'true');

        document.getElementById('close-preset-overlay').style.display = 'block';
      } else {
        localStorage.removeItem('preset-dont-show');
      }
    });


    document.getElementById('preset-top-btn')?.addEventListener('click', () => {
      this.show();

      document.getElementById('close-preset-overlay').style.display = 'block';
    });


    this.overlay?.addEventListener('click', (e) => {
      if (e.target === this.overlay && document.getElementById('preset-dont-show')?.checked) {
        this.hide();
      }
    });
  }





  async loadPresets() {
    try {
      const { data, error } = await this.supabase
        .from('official_presets')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('popularity', { ascending: false });

      if (error) throw error;

      this.presets = data || [];
      this.renderCurrentPage();
      this.updateIndicators();
      this.updateArrows();

    } catch (error) {
      console.error('Failed to load presets:', error);
      this.carousel.innerHTML = '<div class="preset-empty"><p>Failed to load presets</p></div>';
    }
  }





  renderCurrentPage() {
    if (!this.carousel) return;


    this.cleanupPreviews();

    if (!this.presets || this.presets.length === 0) {
      this.carousel.innerHTML = '<div class="preset-empty"><p>No presets available</p></div>';
      return;
    }


    const start = this.currentPage * this.presetsPerPage;
    const end = start + this.presetsPerPage;
    const pagePresets = this.presets.slice(start, end);


    this.carousel.innerHTML = '';


    pagePresets.forEach(preset => {
      const card = this.createPresetCard(preset);
      this.carousel.appendChild(card);
    });
  }

  createPresetCard(preset) {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.dataset.presetId = preset.id;


    const thumbnail = document.createElement('div');
    thumbnail.className = 'preset-thumbnail';


    if (preset.config?.baseMesh) {
      this.createPresetPreview(thumbnail, preset);
    } else if (preset.thumbnail) {

      const img = document.createElement('img');
      img.src = preset.thumbnail;
      img.alt = preset.name;
      thumbnail.appendChild(img);
    } else {
      thumbnail.innerHTML = '<div class="preset-no-preview">No Preview</div>';
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
      preset.tags.slice(0, 2).forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'preset-tag';
        tagEl.textContent = tag;
        tags.appendChild(tagEl);
      });
      info.appendChild(tags);
    }

    card.appendChild(thumbnail);
    card.appendChild(info);


    card.addEventListener('click', () => {
      this.selectPreset(preset);
    });

    return card;
  }

async createPresetPreview(container, preset) {
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-canvas';
    previewContainer.setAttribute('role', 'img');
    previewContainer.setAttribute('aria-label', `${preset.name} 3D preview`);
    previewContainer.innerHTML = '<div class="preset-preview-loading">Loading 3D preview…</div>';
    container.appendChild(previewContainer);
    const generation = this.previewGeneration;
    const meshKey = preset.config?.baseMesh?.r2Key;
    if (!meshKey) {
      this.renderPresetThumbnail(previewContainer, preset);
      return;
    }

    try {
      const gltfPath = await this.getPreviewAssetUrl('basemesh', meshKey);
      const clothingEntries = Object.entries(preset.config?.clothing || {})
        .filter(([, item]) => item?.r2Key);
      const clothingPaths = await Promise.all(clothingEntries.map(async ([category, item]) => {
        try {
          return {
            path: await this.getPreviewAssetUrl(category, item.r2Key),
            target: item.id || category
          };
        } catch (error) {
          console.warn(`Preset clothing preview unavailable for ${preset.name}:`, error);
          return null;
        }
      }));
      if (generation !== this.previewGeneration || !previewContainer.isConnected) return;
      previewContainer.replaceChildren();
      const preview = createPreview({
        container: previewContainer,
        gltfPath,
        autoRotate: true,
        clothingPaths: clothingPaths.filter(Boolean),
        blendShapes: preset.config?.blendShapes || {},
        colors: preset.config?.colors || {}
      });
      this.activePreviews.set(previewContainer, preview);
    } catch (error) {
      console.warn(`Preset preview unavailable for ${preset.name}:`, error);
      if (generation === this.previewGeneration && previewContainer.isConnected) {
        this.renderPresetThumbnail(previewContainer, preset);
      }
    }
  }

  getPreviewAssetUrl(bucket, filename) {
    const key = `${bucket}:${filename}`;
    let urlPromise = this.previewUrlPromises.get(key);
    if (!urlPromise) {
      urlPromise = this.getAssetUrl(bucket, filename);
      this.previewUrlPromises.set(key, urlPromise);
      urlPromise.catch(() => {
        if (this.previewUrlPromises.get(key) === urlPromise) {
          this.previewUrlPromises.delete(key);
        }
      });
    }
    return urlPromise;
  }

  renderPresetThumbnail(container, preset) {
    container.replaceChildren();
    if (preset.thumbnail) {
      const image = document.createElement('img');
      image.src = preset.thumbnail;
      image.alt = `${preset.name} preview`;
      image.loading = 'lazy';
      container.appendChild(image);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'preset-no-preview';
      fallback.textContent = 'Preview unavailable';
      container.appendChild(fallback);
    }
  }





  previousPage() {
    if (this.currentPage > 0) {
      this.currentPage--;
      this.renderCurrentPage();
      this.updateIndicators();
      this.updateArrows();
    }
  }

  nextPage() {
    const totalPages = Math.ceil(this.presets.length / this.presetsPerPage);
    if (this.currentPage < totalPages - 1) {
      this.currentPage++;
      this.renderCurrentPage();
      this.updateIndicators();
      this.updateArrows();
    }
  }

  updateArrows() {
    const totalPages = Math.ceil(this.presets.length / this.presetsPerPage);


    if (this.currentPage === 0) {
      this.leftArrow?.setAttribute('disabled', 'true');
    } else {
      this.leftArrow?.removeAttribute('disabled');
    }


    if (this.currentPage >= totalPages - 1 || totalPages <= 1) {
      this.rightArrow?.setAttribute('disabled', 'true');
    } else {
      this.rightArrow?.removeAttribute('disabled');
    }
  }

  updateIndicators() {
    if (!this.indicators) return;

    const totalPages = Math.ceil(this.presets.length / this.presetsPerPage);


    if (totalPages <= 1) {
      this.indicators.innerHTML = '';
      return;
    }

    this.indicators.innerHTML = '';

    for (let i = 0; i < totalPages; i++) {
      const dot = document.createElement('div');
      dot.className = 'preset-indicator';
      if (i === this.currentPage) {
        dot.classList.add('active');
      }
      dot.addEventListener('click', () => {
        this.currentPage = i;
        this.renderCurrentPage();
        this.updateIndicators();
        this.updateArrows();
      });
      this.indicators.appendChild(dot);
    }
  }





  selectPreset(preset) {

    document.querySelectorAll('.preset-card').forEach(card => {
      card.classList.remove('active');
    });
    document.querySelector(`[data-preset-id="${preset.id}"]`)?.classList.add('active');


    setTimeout(() => {
      this.hide();
      if (this.onLoadPreset) {
        this.onLoadPreset(preset);
      }
    }, 200);
  }





  show() {
    if (this.overlay) {
      this.overlay.classList.remove('hidden');
      document.body.style.overflow = 'hidden';


      this.loadPresets();
    }
  }

  hide() {
    if (this.overlay) {
      this.overlay.classList.add('hidden');
      document.body.style.overflow = '';


      this.cleanupPreviews();
    }
  }





  cleanupPreviews() {
    this.previewGeneration++;
    this.activePreviews.forEach(preview => preview?.dispose?.());
    this.activePreviews.clear();
  }

  destroy() {
    this.cleanupPreviews();
  }
}

export default PresetOverlay;
