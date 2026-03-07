// js/PresetOverlay.js
// ============================================================================
// PRESET OVERLAY SYSTEM
// Startup overlay with preset carousel and "Preset" button in top panel
// ============================================================================

import { createPreview } from "./PreviewRenderer.js";
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
    
    // For 3D preview rendering
    this.WORKER_URL = WORKER_URL;
    this.getAssetUrl = getAssetUrl;
    this.THREE = THREE;
    this.GLTFLoader = GLTFLoader;
    
    this.presets = [];
    this.currentPage = 0;
    this.presetsPerPage = 8;
    this.activePreviews = new Map();
    
    this.overlay = null;
    this.carousel = null;
    this.leftArrow = null;
    this.rightArrow = null;
    this.indicators = null;
  }

  /* ========================================================================
     INITIALIZATION
     ======================================================================== */

  async init() {
    this.overlay = document.getElementById('preset-overlay');
    this.carousel = document.getElementById('preset-carousel');
    this.leftArrow = document.getElementById('preset-arrow-left');
    this.rightArrow = document.getElementById('preset-arrow-right');
    this.indicators = document.getElementById('preset-indicators');
    
    this.attachEventListeners();
    
    // Load official presets
    await this.loadPresets();
    
    // Check if should show on startup
    const dontShow = localStorage.getItem('preset-dont-show');
    if (!dontShow) {
      this.show();
    } else {
      this.hide();
    }
  }

  attachEventListeners() {
    // Close button
    document.getElementById('close-preset-overlay')?.addEventListener('click', () => {
      this.hide();
    });

    // Navigation arrows
    this.leftArrow?.addEventListener('click', () => {
      this.previousPage();
    });

    this.rightArrow?.addEventListener('click', () => {
      this.nextPage();
    });

    // Start from scratch
    document.getElementById('preset-scratch-btn')?.addEventListener('click', () => {
      this.hide();
      if (this.onStartScratch) {
        this.onStartScratch();
      }
    });

    // Don't show again checkbox
    document.getElementById('preset-dont-show')?.addEventListener('change', (e) => {
      if (e.target.checked) {
        localStorage.setItem('preset-dont-show', 'true');
        // Show close button since they can now reopen via Preset button
        document.getElementById('close-preset-overlay').style.display = 'block';
      } else {
        localStorage.removeItem('preset-dont-show');
      }
    });

    // Preset button in top panel
    document.getElementById('preset-top-btn')?.addEventListener('click', () => {
      this.show();
      // Show close button when opened manually
      document.getElementById('close-preset-overlay').style.display = 'block';
    });

    // Click outside to close (when opened manually)
    this.overlay?.addEventListener('click', (e) => {
      if (e.target === this.overlay && document.getElementById('preset-dont-show')?.checked) {
        this.hide();
      }
    });
  }

  /* ========================================================================
     LOAD PRESETS
     ======================================================================== */

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

  /* ========================================================================
     RENDER PRESETS
     ======================================================================== */

  renderCurrentPage() {
    if (!this.carousel) return;

    // Cleanup old previews
    this.cleanupPreviews();

    if (!this.presets || this.presets.length === 0) {
      this.carousel.innerHTML = '<div class="preset-empty"><p>No presets available</p></div>';
      return;
    }

    // Calculate which presets to show
    const start = this.currentPage * this.presetsPerPage;
    const end = start + this.presetsPerPage;
    const pagePresets = this.presets.slice(start, end);

    // Clear carousel
    this.carousel.innerHTML = '';

    // Render preset cards
    pagePresets.forEach(preset => {
      const card = this.createPresetCard(preset);
      this.carousel.appendChild(card);
    });
  }

  createPresetCard(preset) {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.dataset.presetId = preset.id;

    // Thumbnail with Three.js preview
    const thumbnail = document.createElement('div');
    thumbnail.className = 'preset-thumbnail';

    // Try to create preview from preset config
    if (preset.config?.baseMesh) {
      this.createPresetPreview(thumbnail, preset);
    } else if (preset.thumbnail) {
      // Fallback to static image
      const img = document.createElement('img');
      img.src = preset.thumbnail;
      img.alt = preset.name;
      thumbnail.appendChild(img);
    } else {
      thumbnail.innerHTML = '<div class="preset-no-preview">No Preview</div>';
    }

    // Premium badge
    if (preset.is_premium) {
      const badge = document.createElement('div');
      badge.className = 'preset-premium-badge';
      badge.textContent = '⭐ Premium';
      thumbnail.appendChild(badge);
    }

    // Info
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

    // Tags
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

    // Click to load preset
    card.addEventListener('click', () => {
      this.selectPreset(preset);
    });

    return card;
  }

createPresetPreview(container, preset) {
    // Create simple preview placeholder with gradients
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-canvas';
    container.appendChild(previewContainer);

    // Category-based gradients
    const categoryGradients = {
      'casual': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      'sports': 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
      'professional': 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
      'scifi': 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
      'fantasy': 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
      'urban': 'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
      'creative': 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
      'tactical': 'linear-gradient(135deg, #ff9a56 0%, #ff6a00 100%)',
      'gaming': 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)'
    };

    const gradient = categoryGradients[preset.category] || 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    const categoryLabel = (preset.category || 'Character').toUpperCase();

    previewContainer.innerHTML = `
      <div style="
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: ${gradient};
        border-radius: 8px;
        color: white;
        text-shadow: 0 2px 4px rgba(0,0,0,0.3);
      ">
        <div style="
          font-size: 52px;
          margin-bottom: 8px;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
        ">👤</div>
        <div style="
          font-size: 11px;
          opacity: 0.95;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1.5px;
        ">${categoryLabel}</div>
        <div style="
          font-size: 9px;
          opacity: 0.8;
          margin-top: 4px;
        ">Click to load</div>
      </div>
    `;
  }

  /* ========================================================================
     PAGINATION
     ======================================================================== */

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

    // Left arrow
    if (this.currentPage === 0) {
      this.leftArrow?.setAttribute('disabled', 'true');
    } else {
      this.leftArrow?.removeAttribute('disabled');
    }

    // Right arrow
    if (this.currentPage >= totalPages - 1 || totalPages <= 1) {
      this.rightArrow?.setAttribute('disabled', 'true');
    } else {
      this.rightArrow?.removeAttribute('disabled');
    }
  }

  updateIndicators() {
    if (!this.indicators) return;

    const totalPages = Math.ceil(this.presets.length / this.presetsPerPage);

    // Only show indicators if more than 1 page
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

  /* ========================================================================
     ACTIONS
     ======================================================================== */

  selectPreset(preset) {
    // Mark as selected
    document.querySelectorAll('.preset-card').forEach(card => {
      card.classList.remove('active');
    });
    document.querySelector(`[data-preset-id="${preset.id}"]`)?.classList.add('active');

    // Load preset with small delay for visual feedback
    setTimeout(() => {
      this.hide();
      if (this.onLoadPreset) {
        this.onLoadPreset(preset);
      }
    }, 200);
  }

  /* ========================================================================
     SHOW/HIDE
     ======================================================================== */

  show() {
    if (this.overlay) {
      this.overlay.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      
      // Reload presets to ensure fresh data
      this.loadPresets();
    }
  }

  hide() {
    if (this.overlay) {
      this.overlay.classList.add('hidden');
      document.body.style.overflow = '';
      
      // Cleanup previews
      this.cleanupPreviews();
    }
  }

  /* ========================================================================
     CLEANUP
     ======================================================================== */

  cleanupPreviews() {
    this.activePreviews.forEach((preview, container) => {
      if (preview && preview.cleanup) {
        preview.cleanup();
      }
    });
    this.activePreviews.clear();
  }

  destroy() {
    this.cleanupPreviews();
  }
}

export default PresetOverlay;