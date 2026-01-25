(function(){
  "use strict";

  const STORAGE_KEYS = {
    tier: "wavcue_tier",
    authValidUntil: "wavcue_auth_valid_until_ms",
    demoActivatedAt: "wavcue_demo_activated_at_ms",
    demoExportSuccessCount: "wavcue_demo_export_success_count",
  };

  const AUTH_TTL_MS = 60 * 60 * 1000;
  const DEMO_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
  const DEMO_EXPORT_LIMIT = 20;

  const safeGetItem = (key)=>{
    try{
      return window.localStorage ? window.localStorage.getItem(key) : null;
    }catch(_){
      return null;
    }
  };

  const safeSetItem = (key, value)=>{
    try{
      if(window.localStorage){
        window.localStorage.setItem(key, String(value));
      }
    }catch(_){ }
  };

  const safeGetNumber = (key)=>{
    const raw = safeGetItem(key);
    if(raw == null) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  };

  const clampTier = (value)=>{
    const raw = String(value || "").toLowerCase().trim();
    if(raw === "pro" || raw === "standard" || raw === "demo") return raw;
    return "pro";
  };

  const getTier = ()=>{
    return clampTier(safeGetItem(STORAGE_KEYS.tier) || "pro");
  };

  const ensureDemoActivation = (now)=>{
    let activated = safeGetNumber(STORAGE_KEYS.demoActivatedAt);
    if(!activated){
      activated = now;
      safeSetItem(STORAGE_KEYS.demoActivatedAt, activated);
    }
    return activated;
  };

  const getStatus = ()=>{
    const tier = getTier();
    const now = Date.now();
    const authValidUntilMs = safeGetNumber(STORAGE_KEYS.authValidUntil) || null;
    let demoActivatedAtMs = null;
    let demoExpiresAtMs = null;
    let demoExportSuccessCount = safeGetNumber(STORAGE_KEYS.demoExportSuccessCount) || 0;
    let isDemoLocked = false;

    if(tier === "demo"){
      demoActivatedAtMs = ensureDemoActivation(now);
      demoExpiresAtMs = demoActivatedAtMs + DEMO_DURATION_MS;
      const authValid = authValidUntilMs && authValidUntilMs >= now;
      if(!authValid) isDemoLocked = true;
      if(demoExpiresAtMs && now >= demoExpiresAtMs) isDemoLocked = true;
    }

    return {
      tier,
      authValidUntilMs,
      demoActivatedAtMs,
      demoExpiresAtMs,
      demoExportSuccessCount,
      isDemoLocked,
    };
  };

  const fetchWithTimeout = async (url, timeoutMs)=>{
    const controller = new AbortController();
    const timer = setTimeout(()=> controller.abort(), timeoutMs);
    try{
      return await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
    }finally{
      clearTimeout(timer);
    }
  };

  const checkOnline = async ()=>{
    const urls = [
      "https://www.gstatic.com/generate_204",
      "https://www.google.com/generate_204",
      "https://cloudflare.com/cdn-cgi/trace",
      "https://one.one.one.one/cdn-cgi/trace",
    ];

    for(const url of urls){
      try{
        const res = await fetchWithTimeout(url, 3500);
        if(res && (res.status === 200 || res.status === 204)) return true;
      }catch(_){
        // continue
      }
    }
    return false;
  };

  const ensureOnlineAndRefreshAuth = async ()=>{
    const tier = getTier();
    if(tier === "pro") return { ok:true };

    const now = Date.now();
    try{
      const online = await checkOnline();
      if(online){
        safeSetItem(STORAGE_KEYS.authValidUntil, now + AUTH_TTL_MS);
        return { ok:true };
      }
      safeSetItem(STORAGE_KEYS.authValidUntil, now - 1);
      return { ok:false, reason: "オンライン認証に失敗しました。" };
    }catch(_){
      safeSetItem(STORAGE_KEYS.authValidUntil, now - 1);
      return { ok:false, reason: "オンライン認証に失敗しました。" };
    }
  };

  const guardResult = (ok, reason)=>{
    return ok ? { ok:true } : { ok:false, reason: reason || "ライセンスの制限により利用できません。" };
  };

  const canExportSingle = ()=>{
    try{
      const status = getStatus();
      const now = Date.now();
      if(status.tier === "pro") return { ok:true };
      if(status.tier === "standard"){
        if(!status.authValidUntilMs || status.authValidUntilMs < now){
          return guardResult(false, "オンライン認証が必要です。再度お試しください。");
        }
        return { ok:true };
      }
      if(status.tier === "demo"){
        if(status.isDemoLocked){
          return guardResult(false, "体験版の期限切れ、またはオンライン認証が必要です。");
        }
        if((status.demoExportSuccessCount || 0) >= DEMO_EXPORT_LIMIT){
          return guardResult(false, "体験版の書き出し回数上限（20回）に達しました。");
        }
        return { ok:true };
      }
      return { ok:true };
    }catch(_){
      return { ok:false, reason: "ライセンス判定に失敗しました。" };
    }
  };

  const canExportBulk = ()=>{
    try{
      return guardResult(getTier() === "pro", "一括書き出しはPro専用です。");
    }catch(_){
      return { ok:false, reason: "ライセンス判定に失敗しました。" };
    }
  };

  const canBulkImport = ()=>{
    try{
      return guardResult(getTier() === "pro", "一括読み込みはPro専用です。");
    }catch(_){
      return { ok:false, reason: "ライセンス判定に失敗しました。" };
    }
  };

  const canBulkCheck = ()=>{
    try{
      return guardResult(getTier() === "pro", "一括チェックはPro専用です。");
    }catch(_){
      return { ok:false, reason: "ライセンス判定に失敗しました。" };
    }
  };

  const canUsePresets = ()=>{
    try{
      return guardResult(getTier() !== "demo", "体験版ではプリセットを利用できません。");
    }catch(_){
      return { ok:false, reason: "ライセンス判定に失敗しました。" };
    }
  };

  const canUseBackup = ()=>{
    try{
      return guardResult(getTier() !== "demo", "体験版ではバックアップが利用できません。");
    }catch(_){
      return { ok:false, reason: "ライセンス判定に失敗しました。" };
    }
  };

  const recordDemoExportSuccess = ()=>{
    try{
      if(getTier() !== "demo") return;
      const current = safeGetNumber(STORAGE_KEYS.demoExportSuccessCount) || 0;
      safeSetItem(STORAGE_KEYS.demoExportSuccessCount, current + 1);
    }catch(_){ }
  };

  window.WavCueLicenseGate = {
    getTier,
    getStatus,
    ensureOnlineAndRefreshAuth,
    canExportSingle,
    canExportBulk,
    canBulkImport,
    canBulkCheck,
    canUsePresets,
    canUseBackup,
    recordDemoExportSuccess,
  };
})();
