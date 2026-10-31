import { supabase } from "../main.js";





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


window._PRICES = PRICES;








const PLAN_TIER = { free: 0, premium: 1, studio: 2 };

async function startCheckout(priceKey) {
  const price = PRICES[priceKey];
  if (!price) { console.error("Unknown price key:", priceKey); return; }


  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    document.getElementById("plans-overlay")?.classList.add("hidden");
    document.body.style.overflow = "";
    document.getElementById("auth-overlay")?.classList.remove("hidden");
    showToastGlobal("Please sign in to make a purchase");
    return;
  }

  const currentPlan = window._currentPlan || "free";


  if (price.mode === "subscription") {
    const targetPlan = priceKey.startsWith("studio") ? "studio" : "premium";


    if (targetPlan === currentPlan) {
      showToastGlobal(`You're already on the ${targetPlan} plan!`);
      return;
    }


    if (PLAN_TIER[currentPlan] > 0 && PLAN_TIER[targetPlan] > PLAN_TIER[currentPlan]) {
      await handleUpgrade(priceKey, price, session, currentPlan, targetPlan);
      return;
    }


    if (PLAN_TIER[currentPlan] > 0 && PLAN_TIER[targetPlan] < PLAN_TIER[currentPlan]) {
      showToastGlobal("To downgrade, cancel your current plan first — your access continues until the billing period ends.");
      return;
    }


  }


  await runCheckout(price, session);
}

async function handleUpgrade(priceKey, price, session, currentPlan, targetPlan) {

  const confirmed = confirm(
    `Upgrade from ${currentPlan.toUpperCase()} → ${targetPlan.toUpperCase()}?\n\n` +
    `• Your card will be charged the prorated difference immediately\n` +
    `• You'll receive bonus credits for the rest of this billing period\n` +
    `• Your next renewal will be at the ${targetPlan} price\n\n` +
    `Proceed?`
  );
  if (!confirmed) return;

  const btn = document.activeElement;
  const originalText = btn?.textContent;
  if (btn?.classList.contains("plan-btn")) {
    btn.disabled    = true;
    btn.textContent = "Upgrading...";
  }

  try {
    const res = await fetch(`${WORKER_URL}/upgrade-subscription`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ newPriceId: price.priceId })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showToastGlobal(data.error || "Upgrade failed — please try again");
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
      return;
    }


    if (data.requiresAction && data.clientSecret) {
      showToastGlobal("Additional payment verification required — redirecting...");




      window.open("https://billing.stripe.com/p/login", "_blank");
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
      return;
    }


    window._currentPlan = data.newPlan;

    showToastGlobal(
      `🎉 Upgraded to ${data.newPlan.toUpperCase()}! ` +
      (data.creditsAdded > 0 ? `+${data.creditsAdded} credits added.` : "")
    );


    setTimeout(async () => {
      if (typeof window.fetchAndDisplayPlan === "function") {
        const { data: { session: s } } = await supabase.auth.getSession();
        if (s) await window.fetchAndDisplayPlan(s.user.id);
      }


      const { data: credData } = await supabase
        .from("users")
        .select("credits")
        .eq("id", session.user.id)
        .single();
      if (credData) {
        const el = document.getElementById("credits-count");
        if (el) el.textContent = credData.credits;
      }


      document.getElementById("plans-overlay")?.classList.add("hidden");
      document.body.style.overflow = "";
    }, 500);

  } catch (err) {
    console.error("Upgrade error:", err);
    showToastGlobal("Connection error — please try again");
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

async function runCheckout(price, session) {
  const btn = document.activeElement;
  const originalText = btn?.textContent;
  if (btn?.classList.contains("plan-btn")) {
    btn.disabled    = true;
    btn.textContent = "Loading...";
  }

  try {
    const res = await fetch(`${WORKER_URL}/create-checkout`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
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




function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("payment");

  if (result === "success") {
    window.history.replaceState({}, "", window.location.pathname);


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




export function initPlansOverlayControls() {
  const plansOverlay  = document.getElementById("plans-overlay");
  const closePlansBtn = document.getElementById("close-plans");
  if (!plansOverlay || !closePlansBtn) return;


  document.querySelectorAll(".open-plans").forEach(btn => {
    btn.addEventListener("click", () => openOverlay("plans"));
  });
  document.querySelectorAll(".open-credits").forEach(btn => {
    btn.addEventListener("click", () => openOverlay("credits"));
  });
  closePlansBtn.addEventListener("click", closeOverlay);
  plansOverlay.querySelector(".overlay-backdrop")?.addEventListener("click", closeOverlay);


  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });


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


  const creditPacks = document.querySelectorAll(".credit-pack");
  const creditKeys  = ["credits_5", "credits_10", "credits_25"];
  creditPacks.forEach((pack, i) => {
    pack.querySelector(".plan-btn")?.addEventListener("click", () => {
      startCheckout(creditKeys[i]);
    });
  });


  handleStripeReturn();


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