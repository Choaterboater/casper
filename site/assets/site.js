// Casper site: tiny, optional helpers. Every page works without this file.
//  1. Mobile nav: adds a Menu button that folds the nav on small screens.
//  2. Copy buttons: adds "Copy" to each <div class="cmd"> install command.
//  3. Tables with 3 or more columns: each cell gets its column name (data-label), so on a
//     phone each row stacks into a small card. Without JS the table just scrolls sideways.
//  4. Terminal captures: long runs of ─ become <span class="rule">, so on a phone a divider
//     is cut at the edge instead of wrapping into rows of dashes. The text is unchanged.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");

  // 1. Mobile nav toggle
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  // 2. Copy buttons on install commands
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        if (document.execCommand("copy")) resolve();
        else reject(new Error("copy failed"));
      } catch (error) {
        reject(error);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  var blocks = document.querySelectorAll(".cmd");
  Array.prototype.forEach.call(blocks, function (block) {
    var code = block.querySelector("code") || block.querySelector("pre");
    if (!code) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy command");
    var status = document.createElement("span");
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    button.addEventListener("click", function () {
      copyText(code.textContent.trim()).then(function () {
        button.textContent = "Copied";
        status.textContent = "Command copied";
      }, function () {
        button.textContent = "Select it";
        status.textContent = "Could not copy. Select the text instead.";
      });
      window.setTimeout(function () {
        button.textContent = "Copy";
        status.textContent = "";
      }, 2000);
    });
    block.classList.add("has-copy");
    block.appendChild(button);
    block.appendChild(status);
  });

  // 3. Stackable tables
  var wraps = document.querySelectorAll(".table-wrap");
  Array.prototype.forEach.call(wraps, function (wrap) {
    var heads = wrap.querySelectorAll("thead th");
    if (heads.length < 3) return;
    var names = Array.prototype.map.call(heads, function (th) { return th.textContent.trim(); });
    Array.prototype.forEach.call(wrap.querySelectorAll("tbody tr"), function (row) {
      Array.prototype.forEach.call(row.children, function (cell, i) {
        if (names[i]) cell.setAttribute("data-label", names[i]);
      });
    });
    wrap.classList.add("stacks");
  });

  // Contents links reveal a folded release, including when a page opens at its hash.
  function revealHash() {
    var id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    var target = document.getElementById(id);
    if (!target) return;
    var details = target.closest("details");
    if (details && !details.open) {
      details.open = true;
      target.scrollIntoView();
    }
  }
  window.addEventListener("hashchange", revealHash);
  revealHash();

  // "On this page": the link for the section in view is marked, and kept in view in the sidebar.
  var toc = document.querySelector(".toc");
  var tocLinks = toc ? Array.prototype.filter.call(toc.querySelectorAll('a[href^="#"]'), function (link) {
    return document.getElementById(link.getAttribute("href").slice(1));
  }) : [];
  if (tocLinks.length) {
    var current = null;
    var pending = false;
    var markCurrent = function () {
      pending = false;
      var found = null;
      tocLinks.forEach(function (link) {
        var target = document.getElementById(link.getAttribute("href").slice(1));
        if (target.getClientRects().length && target.getBoundingClientRect().top <= 120) found = link;
      });
      if (found === current) return;
      if (current) current.removeAttribute("aria-current");
      current = found;
      if (!current) return;
      current.setAttribute("aria-current", "location");
      if (toc.scrollHeight > toc.clientHeight) {
        var top = current.getBoundingClientRect().top - toc.getBoundingClientRect().top + toc.scrollTop;
        if (top < toc.scrollTop || top > toc.scrollTop + toc.clientHeight - 40) toc.scrollTop = top - toc.clientHeight / 3;
      }
    };
    window.addEventListener("scroll", function () {
      if (!pending) { pending = true; window.requestAnimationFrame(markCurrent); }
    }, { passive: true });
    markCurrent();
  }

  // 4. Divider lines in terminal captures
  var terms = document.querySelectorAll("pre.term");
  Array.prototype.forEach.call(terms, function (term) {
    if (term.innerHTML.indexOf("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500") === -1) return;
    term.innerHTML = term.innerHTML.replace(/\u2500{8,}/g, function (run) {
      return '<span class="rule">' + run + "</span>";
    });
  });
})();
