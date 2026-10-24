/* 西红精算 · 人身保险产品基础知识问答 Agent
   1) 本地检索：中文 bigram + IDF 打分，从 77 条手册原文中取 TopK
   2) 大模型：OpenAI 兼容接口流式作答（用户自带 Key，存 localStorage）
   3) 降级：未配置 Key 时直接返回知识库原文命中条目 */
(function () {
  "use strict";

  var KB = window.KB;
  if (!KB || !KB.items) {
    document.getElementById("answerBody").textContent = "知识库加载失败，请确认 kb.js 存在。";
    return;
  }

  var LS_KEY = "xh_life_qa_llm_cfg";
  var TOPK = 5;
  var WEAK_SCORE = 1.5; // 绝对下限；实际阈值取 max(此值, 最高分×0.3)

  /* ============ 一、检索 ============ */
  function norm(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "")
      .replace(/[，。、；：？！「」『』（）《》“”‘’\.\,\!\?\:\;\'\"\(\)\[\]\{\}—\-–_…·\/\\]/g, "");
  }

  function grams(s) {
    var t = norm(s), out = [], i;
    if (!t) return out;
    for (i = 0; i < t.length - 1; i++) out.push(t.substr(i, 2));
    if (t.length === 1) out.push(t);
    return out;
  }

  function countMap(arr) {
    var m = Object.create(null);
    for (var i = 0; i < arr.length; i++) m[arr[i]] = (m[arr[i]] || 0) + 1;
    return m;
  }

  // 预建索引
  var DOCS = KB.items.map(function (it) {
    var qg = grams(it.q), ag = grams(it.a + " " + (it.upd || ""));
    return {
      it: it,
      qm: countMap(qg),
      am: countMap(ag),
      text: norm(it.q + it.a + (it.upd || "")),
      cat: norm(it.cat)
    };
  });

  var DF = Object.create(null);
  DOCS.forEach(function (d) {
    var seen = Object.create(null);
    Object.keys(d.qm).forEach(function (g) { seen[g] = 1; });
    Object.keys(d.am).forEach(function (g) { seen[g] = 1; });
    Object.keys(seen).forEach(function (g) { DF[g] = (DF[g] || 0) + 1; });
  });
  var N = DOCS.length || 1;
  function idf(g) { return Math.log((N + 1) / ((DF[g] || 0) + 1)) + 1; }

  // 消费者口语 → 手册书面语
  var SYN = [
    ["投连险", "投资连结型保险"], ["投连", "投资连结"],
    ["定寿", "定期寿险"], ["重疾险", "重大疾病保险"], ["重疾", "重大疾病"],
    ["现价", "现金价值"], ["百万医疗险", "医疗保险"], ["百万医疗", "医疗保险"],
    ["意外险", "意外伤害保险"], ["身故", "死亡"], ["全残", "残疾"],
    ["保费", "保险费"], ["保额", "保险金额"], ["教育金", "教育年金"],
    ["养老金", "养老年金"], ["养老", "养老年金"], ["年金险", "年金保险"],
    ["分红险", "分红型保险"], ["万能险", "万能型保险"], ["告知", "如实告知"],
    ["退保", "解除合同"], ["失效", "效力中止"], ["复效", "恢复合同效力"],
    ["理赔", "保险金"], ["出险", "保险事故"], ["保单借款", "保单贷款"],
    ["保险公司", "保险人"], ["不赔", "责任免除"], ["等待期", "保险期间"]
  ];
  function expandQuery(q) {
    var out = q;
    for (var i = 0; i < SYN.length; i++) {
      if (q.indexOf(SYN[i][0]) >= 0 && out.indexOf(SYN[i][1]) < 0) out += SYN[i][1];
    }
    return out;
  }

  function search(query, topK) {
    topK = topK || TOPK;
    var qn = norm(query);
    var qterms = Object.keys(countMap(grams(expandQuery(query))));
    var normSum = 0;
    qterms.forEach(function (g) { normSum += idf(g); });

    var hits = [];
    for (var i = 0; i < DOCS.length; i++) {
      var d = DOCS[i], s = 0, k, hitTerms = 0;
      for (k = 0; k < qterms.length; k++) {
        var g = qterms[k], w = idf(g), got = false;
        if (d.qm[g]) { s += w * 3 * Math.min(d.qm[g], 2); got = true; }
        if (d.am[g]) { s += w * 1 * Math.min(d.am[g], 3); got = true; }
        if (got) hitTerms++;
      }
      if (!s) continue;
      // 覆盖率加权：查询里命中的词越多越可信
      s *= 0.6 + 0.4 * (hitTerms / qterms.length);
      if (qn.length >= 2) {
        if (d.text.indexOf(qn) >= 0) s += 8;
        if (d.cat.indexOf(qn) >= 0) s += 3;
      }
      if (s > 0) hits.push({ it: d.it, score: s / Math.sqrt(normSum + 1) });
    }
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, topK);
  }

  /* ============ 二、极简 Markdown 渲染 ============ */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    var t = esc(s);
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/`(.+?)`/g, "<code>$1</code>");
    return t;
  }
  function md(text) {
    var lines = String(text).split("\n"), out = "", inUl = false, inOl = false, para = [];
    function closeList() {
      if (inUl) { out += "</ul>"; inUl = false; }
      if (inOl) { out += "</ol>"; inOl = false; }
    }
    function flushPara() {
      if (para.length) { out += "<p>" + inline(para.join(" ")) + "</p>"; para = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim(), m;
      if (!line) { flushPara(); closeList(); continue; }
      if ((m = line.match(/^#{1,4}\s*(.+)$/))) {
        flushPara(); closeList(); out += "<h4>" + inline(m[1]) + "</h4>"; continue;
      }
      if ((m = line.match(/^[-*•]\s+(.+)$/))) {
        flushPara();
        if (!inUl) { closeList(); out += "<ul>"; inUl = true; }
        out += "<li>" + inline(m[1]) + "</li>"; continue;
      }
      if ((m = line.match(/^\d+[.、)]\s*(.+)$/))) {
        flushPara();
        if (!inOl) { closeList(); out += "<ol>"; inOl = true; }
        out += "<li>" + inline(m[1]) + "</li>"; continue;
      }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    return out;
  }

  /* ============ 三、配置 ============ */
  function loadCfg() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var d = raw ? JSON.parse(raw) : {};
      return {
        base: d.base || "", key: d.key || "", model: d.model || "",
        noStream: !!d.noStream
      };
    } catch (e) { return { base: "", key: "", model: "", noStream: false }; }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  var cfg = loadCfg();
  function hasLLM() { return !!(cfg.base && cfg.key && cfg.model); }

  /* ============ 四、大模型调用（流式） ============ */
  function buildMessages(question, hits) {
    var refs = hits.map(function (h, i) {
      var it = h.it, s = "[" + (i + 1) + "] 分类：" + it.cat + "\n问题：" + it.q + "\n答案：" + it.a;
      if (it.upd) s += "\n口径更新：" + it.upd;
      return s;
    }).join("\n\n");

    var sys =
      "你是「西红精算」的人身保险基础知识问答助手，面向普通消费者。\n\n" +
      "【回答规则】\n" +
      "1. 只依据【参考资料】回答。资料里没有的，直接说明「手册里没有这一条，建议咨询保险公司官方客服或监管热线」，不要编造。\n" +
      "2. 说人话：出现术语必须立刻用大白话翻译一遍（例如：现金价值——就是退保时能拿回的那部分钱）。\n" +
      "3. 不卖焦虑、不推销、不推荐任何具体公司或产品，不做收益承诺。\n" +
      "4. 先给结论再分点说明；涉及数字照抄资料原文，不要自行换算。\n" +
      "5. 资料中若有「口径更新」，一律以更新后的现行口径为准，并注明「以现行监管口径为准」。\n" +
      "6. 末尾用一句话提醒：具体以保险合同条款和现行监管规定为准。\n" +
      "7. 简体中文，正文控制在 400 字以内，可用加粗强调关键句。\n\n" +
      "【参考资料】\n" + (refs || "（本次未检索到相关条目）");

    return [
      { role: "system", content: sys },
      { role: "user", content: question }
    ];
  }

  function chatUrl(base) {
    var b = String(base).replace(/\/+$/, "");
    if (/\/chat\/completions$/.test(b)) return b;
    return b + "/chat/completions";
  }

  function streamChat(messages, onDelta) {
    return fetch(chatUrl(cfg.base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.key
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: messages,
        stream: true,
        temperature: 0.2
      })
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          throw new Error("HTTP " + resp.status + " " + String(t).slice(0, 220));
        });
      }
      var reader = resp.body.getReader();
      var dec = new TextDecoder("utf-8");
      var buf = "", full = "";

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            // 一段都没解析出来 —— 可能是网关直接返回了完整 JSON
            if (!full && buf.trim()) {
              try {
                var j = JSON.parse(buf);
                var c = j.choices && j.choices[0] && (j.choices[0].message || {}).content;
                if (c) { full = c; onDelta(c); }
              } catch (e) {}
            }
            return full;
          }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var t = lines[i].trim();
            if (t.indexOf("data:") !== 0) continue;
            var data = t.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              var o = JSON.parse(data);
              var d = o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content;
              if (d) { full += d; onDelta(d); }
            } catch (e) {}
          }
          return pump();
        });
      }
      return pump();
    });
  }

  // 非流式兜底
  function plainChat(messages) {
    return fetch(chatUrl(cfg.base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.key
      },
      body: JSON.stringify({ model: cfg.model, messages: messages, temperature: 0.2 })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + " " + String(t).slice(0, 220)); });
      return r.json();
    }).then(function (j) {
      var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return c || "";
    });
  }

  /* ============ 五、UI ============ */
  var $ = function (id) { return document.getElementById(id); };
  var answerCard = $("answerCard"), answerBody = $("answerBody"), answerTitle = $("answerTitle");
  var modeBadge = $("modeBadge"), srcList = $("srcList"), sources = $("sources");
  var btnAsk = $("btnAsk"), qEl = $("q");

  function escHtml(s) { return esc(s); }

  function renderSources(hits) {
    if (!hits.length) { sources.style.display = "none"; return; }
    sources.style.display = "block";
    srcList.innerHTML = hits.map(function (h, i) {
      var it = h.it;
      var upd = it.upd ? '<span class="upd">🔄 ' + escHtml(it.upd) + "</span>" : "";
      return '<details class="src-item"' + (i === 0 ? " open" : "") + ">" +
        "<summary>" + escHtml(it.q) +
        '<span class="src-meta">' + escHtml(it.cat) + " · 相关度 " + h.score.toFixed(1) + "</span></summary>" +
        '<div class="src-body"><div class="q-line">问：' + escHtml(it.q) + "</div>" +
        escHtml(it.a).replace(/\n/g, "<br>") + upd + "</div></details>";
    }).join("");
  }

  function localAnswer(question, hits) {
    if (!hits.length) {
      return "知识库里没找到直接相关的条目。手册覆盖的是人身保险产品基础知识（概念、分类、新型产品、投保、告知、退保、理赔等九大类），换个说法再试试？\n\n真买保险、真出险理赔，以保险合同条款和现行监管规定为准。";
    }
    var head = "未配置大模型，以下是知识库原文的命中结果：\n\n";
    var body = hits.slice(0, 3).map(function (h, i) {
      var it = h.it, s = "**" + (i + 1) + ". " + it.q + "**\n" + it.a;
      if (it.upd) s += "\n🔄 口径更新：" + it.upd.replace(/^🔄\s*口径更新：/, "");
      return s;
    }).join("\n\n");
    return head + body + "\n\n（配置大模型后可获得整合后的大白话作答，点右上角「模型设置」。答案以手册原文为准，具体以保险合同条款和现行监管规定为准。）";
  }

  function setMode() {
    var on = hasLLM();
    modeBadge.textContent = on ? "大模型 · " + cfg.model : "本地检索";
    modeBadge.className = "mode-badge" + (on ? " llm" : "");
    $("modeTag").textContent = "当前：" + (on ? "大模型模式" : "本地检索模式");
  }

  var busy = false;
  function ask(question) {
    question = (question || "").trim();
    if (!question || busy) return;
    busy = true;
    btnAsk.disabled = true;
    btnAsk.textContent = "回答中…";

    var hits = search(question, TOPK);
    // 相对 + 绝对双阈值：既保住高分条目的伴生条目，又滤掉勉强沾边的噪声
    var thr = hits.length ? Math.max(WEAK_SCORE, hits[0].score * 0.3) : 0;
    var strong = hits.filter(function (h) { return h.score >= thr; });
    var useHits = strong.length ? strong : hits.slice(0, 2);

    answerCard.classList.add("show");
    answerTitle.textContent = question.length > 26 ? question.slice(0, 26) + "…" : question;
    renderSources(useHits.length ? useHits : hits.slice(0, 3));
    answerBody.innerHTML = '<span class="cursor"></span>';

    if (!hasLLM()) {
      answerBody.innerHTML = md(localAnswer(question, useHits));
      busy = false;
      btnAsk.disabled = false;
      btnAsk.textContent = "提问";
      return;
    }

    var acc = "";
    function paint() { answerBody.innerHTML = md(acc) + '<span class="cursor"></span>'; }

    var msgs = buildMessages(question, useHits);
    var first = cfg.noStream
      ? plainChat(msgs).then(function (t) { acc = t || ""; return acc; })
      : streamChat(msgs, function (d) { acc += d; paint(); })
          .then(function (full) {
            if (!full) return plainChat(msgs).then(function (t) { return t; });
            return full;
          });

    first
      .then(function (text) {
        acc = text || acc;
        return acc;
      })
      .then(function (text) {
        acc = text || acc;
        answerBody.innerHTML = md(acc);
      })
      .catch(function (err) {
        var msg = String(err && err.message || err);
        var tip;
        if (/Failed to fetch|NetworkError|TypeError|Network request failed/i.test(msg)) {
          tip = "调用失败：请求没能送到服务商（" + msg.slice(0, 50) + "）。\n\n" +
                "已实测 DeepSeek / 硅基流动 / 智谱 / Moonshot / 通义五家的跨域头都正常，**基本可以排除跨域限制**。常见原因是：\n" +
                "1. 公司或家庭网络屏蔽了该 API 域名（可换手机热点一试）\n" +
                "2. 广告拦截 / 隐私保护类浏览器扩展拦掉了请求（可换无痕窗口一试）\n" +
                "3. 接口地址填错（漏了 https:// 前缀、或漏了 /v1）\n" +
                "4. 在 IDE 预览面板或本地 file:// 下打开 —— 请改用系统浏览器访问线上地址\n\n" +
                "点右上角「⚙ 模型设置 → 测试连接」可以逐层定位到底卡在哪一步。\n\n" +
                "不想折腾也能用：下面直接给你知识库原文。";
        } else if (/HTTP 401/.test(msg)) {
          tip = "调用失败：API Key 无效或已过期。请点右上角「模型设置」重新粘贴一个 Key。\n\n下面先用知识库原文作答。";
        } else if (/HTTP 402/.test(msg)) {
          tip = "调用失败：账户余额不足（HTTP 402）。去服务商后台充值后即可恢复 —— DeepSeek 新注册账号最常见这个。\n\n下面先用知识库原文作答。";
        } else if (/HTTP 403/.test(msg)) {
          tip = "调用失败：密钥没有该模型的调用权限（HTTP 403）。换一个模型名或换一个 Key。\n\n下面先用知识库原文作答。";
        } else if (/HTTP 404/.test(msg)) {
          tip = "调用失败：接口地址或模型名不对（HTTP 404）。地址要以 /v1 结尾，模型名请照抄服务商控制台里的名字。\n\n下面先用知识库原文作答。";
        } else if (/HTTP 429/.test(msg)) {
          tip = "调用失败：触发限流（HTTP 429）。稍等一会儿再试。\n\n下面先用知识库原文作答。";
        } else if (/HTTP 4\d\d/.test(msg)) {
          tip = "调用失败：" + msg.slice(0, 160) + "。请检查接口地址与模型名称是否匹配。\n\n下面先用知识库原文作答。";
        } else {
          tip = "调用失败：" + msg.slice(0, 160) + "\n\n下面先用知识库原文作答。";
        }
        answerBody.innerHTML = md(tip) +
          '<details class="src-item" open style="margin-top:12px"><summary>查看知识库原文命中结果</summary>' +
          '<div class="src-body">' + md(localAnswer(question, useHits)) + "</div></details>";
      })
      .then(function () {
        busy = false;
        btnAsk.disabled = false;
        btnAsk.textContent = "提问";
      });
  }

  /* ---- 示例问题 ---- */
  var SAMPLES = [
    "什么是人身保险？",
    "定期寿险和终身寿险有什么区别？",
    "意外伤害保险和定期寿险有什么不同？",
    "分红险的红利是确定的吗？",
    "万能险和投连险有什么不一样？",
    "犹豫期内退保怎么算？",
    "忘了交续期保费，保单会失效吗？",
    "不如实告知会有什么后果？",
    "孩子出生先买什么保险？",
    "爸妈五十多岁还能买什么保险？",
    "未成年人身故保额有限制吗？",
    "出险后怎么申请理赔？"
  ];
  $("chips").innerHTML = SAMPLES.map(function (s) {
    return '<button class="chip" data-q="' + esc(s) + '">' + esc(s) + "</button>";
  }).join("");
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b) return;
    qEl.value = b.getAttribute("data-q");
    ask(qEl.value);
  });

  btnAsk.addEventListener("click", function () { ask(qEl.value); });
  qEl.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ask(qEl.value); }
  });

  /* ---- 知识库浏览 ---- */
  $("kbCount").textContent = "知识库 " + KB.items.length + " 条";
  $("browseSub").textContent = "共 " + KB.items.length + " 条一问一答，点任一问题可直接提问";

  var activeCat = null;
  $("catGrid").innerHTML = KB.cats.map(function (c) {
    return '<button class="cat-btn" data-c="' + esc(c) + '">' + esc(c) + "</button>";
  }).join("");

  function renderCat(c) {
    var list = KB.items.filter(function (it) { return it.cat === c; });
    $("kbList").classList.add("show");
    $("kbList").innerHTML = list.map(function (it) {
      return '<div class="kb-item" data-q="' + esc(it.q) + '">' +
        '<span class="kb-no">' + esc(it.id) + "</span>" +
        '<span class="kb-q">' + esc(it.q) + "</span></div>";
    }).join("");
  }

  $("catGrid").addEventListener("click", function (e) {
    var b = e.target.closest(".cat-btn");
    if (!b) return;
    var c = b.getAttribute("data-c");
    if (activeCat === c) {
      activeCat = null;
      $("kbList").classList.remove("show");
      Array.prototype.forEach.call($("catGrid").children, function (x) { x.classList.remove("active"); });
      return;
    }
    activeCat = c;
    Array.prototype.forEach.call($("catGrid").children, function (x) {
      x.classList.toggle("active", x.getAttribute("data-c") === c);
    });
    renderCat(c);
  });

  $("kbList").addEventListener("click", function (e) {
    var d = e.target.closest(".kb-item");
    if (!d) return;
    qEl.value = d.getAttribute("data-q");
    ask(qEl.value);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* ---- 设置面板 ---- */
  var PRESETS = [
    { name: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { name: "硅基流动", base: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
    { name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
    { name: "Moonshot", base: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
    { name: "通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { name: "本地 Ollama", base: "http://localhost:11434/v1", model: "qwen2.5" }
  ];
  $("presetRow").innerHTML = PRESETS.map(function (p, i) {
    return '<button class="preset" data-i="' + i + '">' + esc(p.name) + "</button>";
  }).join("");
  $("presetRow").addEventListener("click", function (e) {
    var b = e.target.closest(".preset");
    if (!b) return;
    var p = PRESETS[+b.getAttribute("data-i")];
    $("cfgBase").value = p.base;
    $("cfgModel").value = p.model;
  });

  var mask = $("modalMask");
  function openSettings() {
    $("cfgBase").value = cfg.base || "";
    $("cfgKey").value = cfg.key || "";
    $("cfgModel").value = cfg.model || "";
    $("cfgNoStream").checked = !!cfg.noStream;
    $("diagBox").style.display = "none";
    mask.classList.add("show");
  }
  function closeSettings() { mask.classList.remove("show"); }

  $("btnSettings").addEventListener("click", openSettings);
  $("btnCancel").addEventListener("click", closeSettings);
  mask.addEventListener("click", function (e) { if (e.target === mask) closeSettings(); });

  $("btnSave").addEventListener("click", function () {
    cfg = {
      base: $("cfgBase").value.trim(),
      key: $("cfgKey").value.trim(),
      model: $("cfgModel").value.trim(),
      noStream: $("cfgNoStream").checked
    };
    saveCfg(cfg);
    setMode();
    closeSettings();
  });

  /* ---- 连接诊断：把「猜」变成「测」 ---- */
  // 分步探测：地址格式 → 跨域预检 → 真实请求状态码，逐级定位失败点
  function diag(text, cls) {
    var box = $("diagBox");
    box.style.display = "block";
    box.innerHTML += '<div class="diag-line' + (cls ? " " + cls : "") + '">' + text + "</div>";
  }
  function diagnose(base, key, model) {
    var box = $("diagBox");
    box.innerHTML = "";
    box.style.display = "block";

    var url = chatUrl(base);
    diag("① 请求地址：<code>" + esc(url) + "</code>");

    // 地址合法性
    if (!/^https?:\/\//i.test(url)) {
      diag("✗ 地址不完整，必须以 http:// 或 https:// 开头", "bad");
      return;
    }
    if (location.protocol === "https:" && /^http:\/\//i.test(url)) {
      diag("✗ 当前页面是 https，浏览器会拦截 http 请求（混合内容）。请改用 https 接口地址，或改用 Ollama 之外的服务商。", "bad");
      return;
    }
    if (!/\/chat\/completions$/.test(url)) {
      diag("⚠ 地址末尾不是 /chat/completions，已自动补全。若仍失败，检查是否漏了 /v1", "warn");
    }
    if (!key) { diag("✗ 未填 API Key", "bad"); return; }
    if (!model) { diag("✗ 未填模型名称", "bad"); return; }

    var t0 = Date.now();
    diag("② 正在探测（跨域预检 + 真实请求）…");

    var payload = JSON.stringify({
      model: model,
      messages: [{ role: "user", content: "说" }],
      max_tokens: 1,
      stream: false
    });
    var headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key
    };

    fetch(url, { method: "POST", headers: headers, body: payload })
      .then(function (r) {
        var ms = Date.now() - t0;
        var code = r.status;
        return r.text().then(function (t) {
          var body = String(t).slice(0, 300);
          if (code === 200) {
            diag("③ HTTP 200 ✓ 连接成功，耗时 " + ms + "ms", "ok");
            diag("模型可用，可以正常提问了。", "ok");
            return;
          }
          diag("③ HTTP " + code + "（耗时 " + ms + "ms）", code >= 500 ? "warn" : "bad");
          var msg = "";
          try { msg = (JSON.parse(t).error || {}).message || ""; } catch (e) {}
          var advice = {
            401: "密钥无效或已过期 → 重新生成一个 API Key 粘贴进来",
            402: "账户余额不足 → 去服务商后台充值（DeepSeek 新号常见）",
            403: "密钥没有该模型的权限 → 换模型名或换 Key",
            404: "接口地址或模型名不对 → 地址要以 /v1 结尾，模型名照抄服务商控制台",
            422: "请求参数不被接受 → 多半是模型名填错",
            429: "触发限流或并发超限 → 等一会儿再试"
          }[code] || "服务端返回：" + esc(body);
          diag("④ 判定：" + advice, "bad");
          if (msg) diag("⑤ 原文：" + esc(msg.slice(0, 200)), "warn");
        });
      })
      .catch(function (err) {
        // 到这里说明 fetch 根本没拿到响应 —— 网络层被拦
        diag("③ 请求未能送达（" + esc(String(err && err.message || err)) + "）", "bad");
        diag("④ 判定：浏览器发出的请求被拦在到达服务商之前。已实测五家服务商跨域头均正常，所以基本不是跨域问题，按以下顺序排查：", "warn");
        diag("1. 公司/家庭网络是否屏蔽了该域名（换个网络或用手机热点试）", "warn");
        diag("2. 广告拦截、隐私保护类浏览器扩展是否拦截了请求（可无痕窗口试）", "warn");
        diag("3. 地址是否填错（例如漏了 https:// 前缀、多了中文空格）", "warn");
        diag("4. 若你是在 IDE 预览面板或本地 file:// 打开的，请改用系统浏览器访问线上地址", "warn");
      });
  }

  $("btnTest").addEventListener("click", function () {
    diagnose(
      $("cfgBase").value.trim() || cfg.base,
      $("cfgKey").value.trim() || cfg.key,
      $("cfgModel").value.trim() || cfg.model
    );
  });

  $("btnClear").addEventListener("click", function () {
    cfg = { base: "", key: "", model: "", noStream: false };
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    $("cfgBase").value = ""; $("cfgKey").value = ""; $("cfgModel").value = "";
    setMode();
    closeSettings();
  });

  setMode();
})();
