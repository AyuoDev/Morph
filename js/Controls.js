/* ================= Plans & Credits Overlay Controls ================= */

export function initPlansOverlayControls() {
  const plansOverlay = document.getElementById("plans-overlay");
  const closePlansBtn = document.getElementById("close-plans");

  if (!plansOverlay || !closePlansBtn) return;

  // OPEN overlay (Plans)
  document.querySelectorAll(".open-plans").forEach(btn => {
    btn.addEventListener("click", () => {
      openOverlay("plans");
    });
  });

  // OPEN overlay (Credits)
  document.querySelectorAll(".open-credits").forEach(btn => {
    btn.addEventListener("click", () => {
      openOverlay("credits");
    });
  });

  // CLOSE overlay
  closePlansBtn.addEventListener("click", closeOverlay);

  // Close on backdrop click
  plansOverlay.querySelector(".overlay-backdrop")
    ?.addEventListener("click", closeOverlay);

  // TAB switching
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });

  /* ---------- Helpers ---------- */

  function openOverlay(tab) {
    plansOverlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    switchTab(tab);
  }

  function closeOverlay() {
    plansOverlay.classList.add("hidden");
    document.body.style.overflow = "";
  }

  function switchTab(tab) {
    document.querySelectorAll(".tab-btn")
      .forEach(b => b.classList.remove("active"));

    document.querySelectorAll(".tab-content")
      .forEach(c => c.classList.remove("active"));

    document
      .querySelector(`.tab-btn[data-tab="${tab}"]`)
      ?.classList.add("active");

    document.getElementById(`tab-${tab}`)
      ?.classList.add("active");
  }
  const billingToggle = document.querySelector(".toggle-switch");
const billingLabels = document.querySelectorAll(".billing-label");
const panel = document.querySelector(".overlay-panel");

let billingMode = "monthly";

billingToggle?.addEventListener("click", () => {
  billingMode = billingMode === "monthly" ? "yearly" : "monthly";
  panel.classList.toggle("yearly", billingMode === "yearly");

  billingLabels.forEach(l =>
    l.classList.toggle("active", l.dataset.billing === billingMode)
  );
});

billingLabels.forEach(label => {
  label.addEventListener("click", () => {
    billingMode = label.dataset.billing;
    panel.classList.toggle("yearly", billingMode === "yearly");

    billingLabels.forEach(l =>
      l.classList.toggle("active", l === label)
    );
  });
});

}
