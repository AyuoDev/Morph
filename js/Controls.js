import { supabase } from "../main.js";

/* ================================================================
   CONFIGURATION
   ↓↓↓ PASTE YOUR STRIPE PRICE IDs HERE after creating them in Stripe ↓↓↓
================================================================ */
const WORKER_URL = "https://morphara.maroukayuob.workers.dev";

const PRICES = {
  credits_5:       { priceId: "price_1T0WGqIAaSECAqpwNEf0URq6",    mode: "payment",      label: "5 Credits"       },
  credits_10:      { priceId: "price_1T0WIqIAaSECAqpw6B9mcP7c",   mode: "payment",      label: "10 Credits"      },
  credits_25:      { priceId: "price_1T0WKAIAaSECAqpwjcUirAV9",   mode: "payment",      label: "25 Credits"      },
  premium_monthly: { priceId: "price_1T0WLtIAaSECAqpwW49vlwQP", mode: "subscription", label: "Premium Monthly" },
  premium_yearly:  { priceId: "price_1T0WPLIAaSECAqpwnztvHXTx", mode: "subscription", label: "Premium Yearly"  },
  studio_monthly:  { priceId: "price_1T0WMtIAaSECAqpwl7Gu7gem", mode: "subscription", label: "Studio Monthly"  },
  studio_yearly:   { priceId: "price_1T0WQtIAaSECAqpwWYvhtRqd", mode: "subscription", label: "Studio Yearly"   }
};

// Expose prices globally so main.js fetchAndDisplayPlan can match price IDs to plan names
window._PRICES = PRICES;

// supabase imported from main.js — single shared instance

/* ================================================================
   STRIPE CHECKOUT
================================================================ */
async function startCheckout(priceKey) {
  const price = PRICES[priceKey];
  if (!price) { console.error("Unknown price key:", priceKey); return; }

  // Must be logged in
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    document.getElementById("plans-overlay")?.classList.add("hidden");
    document.body.style.overflow = "";
    document.getElementById("auth-overlay")?.classList.remove("hidden");
    showToastGlobal("Please sign in to make a purchase");
    return;
  }

  // Prevent buying the same subscription plan they already have
  if (price.mode === "subscription") {
    const currentPlan = window._currentPlan || "free";
    const isPremiumKey = priceKey.startsWith("premium");
    const isStudioKey  = priceKey.startsWith("studio");

    if ((isPremiumKey && currentPlan === "premium") || (isStudioKey && currentPlan === "studio")) {
      showToastGlobal(`You're already on the ${price.label.split(" ")[0]} plan!`);
      return;
    }
  }

  // Show loading on button
  const btn = document.activeElement;
  const originalText = btn?.textContent;
  if (btn && btn.classList.contains("plan-btn")) {
    btn.disabled    = true;
    btn.textContent = "Loading...";
  }

  try {
    const res = await fetch(`${WORKER_URL}/create-checkout`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        priceId:   price.priceId,
        userId:    session.user.id,
        userEmail: session.user.email,
        mode:      price.mode
      })
    });

    const data = await res.json();

    if (data.url) {
      window.location.href = data.url;
    } else {
      console.error("Checkout error:", data.error);
      showToastGlobal("Payment setup failed — please try again");
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }

  } catch (err) {
    console.error("Checkout error:", err);
    showToastGlobal("Connection error — please try again");
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

/* ================================================================
   HANDLE RETURN FROM STRIPE
================================================================ */
function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("payment");

  if (result === "success") {
    window.history.replaceState({}, "", window.location.pathname);

    // Wait 3 seconds for webhook to process, then refresh credits + plan
    setTimeout(async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase
        .from("users")
        .select("credits")
        .eq("id", session.user.id)
        .single();

      if (!error && data) {
        const el = document.getElementById("credits-count");
        if (el) el.textContent = data.credits;
      }

      // Refresh plan display (calls fetchAndDisplayPlan from main.js)
      if (typeof fetchAndDisplayPlan === "function") {
        await fetchAndDisplayPlan(session.user.id);
      }

      showToastGlobal("Payment successful! Your credits have been added 🎉");
    }, 3000);
  }

  if (result === "cancelled") {
    window.history.replaceState({}, "", window.location.pathname);
    showToastGlobal("Payment cancelled.");
  }
}

/* ================================================================
   TOAST HELPER
================================================================ */
function showToastGlobal(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, 2500);
}

/* ================================================================
   PLANS OVERLAY CONTROLS
================================================================ */
export function initPlansOverlayControls() {
  const plansOverlay  = document.getElementById("plans-overlay");
  const closePlansBtn = document.getElementById("close-plans");
  if (!plansOverlay || !closePlansBtn) return;

  // ── Open / Close ──
  document.querySelectorAll(".open-plans").forEach(btn => {
    btn.addEventListener("click", () => openOverlay("plans"));
  });
  document.querySelectorAll(".open-credits").forEach(btn => {
    btn.addEventListener("click", () => openOverlay("credits"));
  });
  closePlansBtn.addEventListener("click", closeOverlay);
  plansOverlay.querySelector(".overlay-backdrop")?.addEventListener("click", closeOverlay);

  // ── Tabs ──
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // ── Billing toggle ──
  const billingToggle = document.querySelector(".toggle-switch");
  const billingLabels = document.querySelectorAll(".billing-label");
  const overlayPanel  = document.querySelector(".overlay-panel");
  let billingMode = "monthly";

  billingToggle?.addEventListener("click", () => {
    billingMode = billingMode === "monthly" ? "yearly" : "monthly";
    overlayPanel.classList.toggle("yearly", billingMode === "yearly");
    billingLabels.forEach(l =>
      l.classList.toggle("active", l.dataset.billing === billingMode)
    );
  });

  billingLabels.forEach(label => {
    label.addEventListener("click", () => {
      billingMode = label.dataset.billing;
      overlayPanel.classList.toggle("yearly", billingMode === "yearly");
      billingLabels.forEach(l => l.classList.toggle("active", l === label));
    });
  });

  // ── Subscription buttons ──
  const premiumBtn = document.querySelector(".plan-card.premium .plan-btn");
  if (premiumBtn) {
    premiumBtn.addEventListener("click", () => {
      startCheckout(billingMode === "yearly" ? "premium_yearly" : "premium_monthly");
    });
  }

  const studioBtn = document.querySelector(".plan-card.studio .plan-btn");
  if (studioBtn) {
    studioBtn.addEventListener("click", () => {
      startCheckout(billingMode === "yearly" ? "studio_yearly" : "studio_monthly");
    });
  }

  // ── Credit pack buttons ──
  const creditPacks = document.querySelectorAll(".credit-pack");
  const creditKeys  = ["credits_5", "credits_10", "credits_25"];
  creditPacks.forEach((pack, i) => {
    pack.querySelector(".plan-btn")?.addEventListener("click", () => {
      startCheckout(creditKeys[i]);
    });
  });

  // ── Handle Stripe return ──
  handleStripeReturn();

  /* ---- Helpers ---- */
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
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add("active");
    document.getElementById(`tab-${tab}`)?.classList.add("active");
  }
}
