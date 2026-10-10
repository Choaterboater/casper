// Casper site: home page extras (index.html only). The page works without this file.
//  1. Install tabs: macOS / Linux and Windows commands behind two tabs.
//  2. Ghost eyes follow the pointer (not with reduced motion).
//  3. Terminal replay: the real run types itself out when it scrolls into view
//     (not with reduced motion; then the finished run just shows).
(function () {
  "use strict";
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 1. Install tabs ------------------------------------------------------
  var install = document.getElementById("install");
  var tablist = install && install.querySelector('[role="tablist"]');
  if (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var select = function (tab, focus) {
      tabs.forEach(function (other) {
        var on = other === tab;
        other.setAttribute("aria-selected", on ? "true" : "false");
        other.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(other.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach(function (tab, index) {
      var panel = document.getElementById(tab.getAttribute("aria-controls"));
      if (panel) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tab.id);
      }
      tab.addEventListener("click", function () { select(tab, false); });
      tab.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
        else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === "Home") next = tabs[0];
        else if (event.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          event.preventDefault();
          select(next, true);
        }
      });
    });
    tablist.hidden = false;
    install.classList.add("is-tabbed");
    select(tabs[0], false);
  }

  // 2. Ghost eyes --------------------------------------------------------
  var ghost = document.querySelector(".ghost-svg");
  var eyes = document.querySelectorAll(".ghost-eye");
  if (ghost && eyes.length && !reduceMotion) {
    var pending = null;
    var scheduled = false;
    var MAX = 2; // SVG units
    window.addEventListener("pointermove", function (event) {
      pending = { x: event.clientX, y: event.clientY };
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        if (!pending) return;
        var box = ghost.getBoundingClientRect();
        var dx = pending.x - (box.left + box.width / 2);
        var dy = pending.y - (box.top + box.height * 0.45);
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var reach = Math.min(1, dist / 240);
        var tx = (dx / dist) * MAX * reach;
        var ty = (dy / dist) * MAX * reach;
        Array.prototype.forEach.call(eyes, function (eye) {
          eye.setAttribute("transform", "translate(" + tx.toFixed(2) + " " + ty.toFixed(2) + ")");
        });
        pending = null;
      });
    }, { passive: true });
  }

  // 3. Terminal replay ---------------------------------------------------
  var term = document.getElementById("replay-term");
  var replayBtn = document.querySelector(".replay-btn");
  if (!term || reduceMotion) return;

  // Each line of the capture holds whole spans, so splitting on newlines keeps valid HTML.
  var source = term.innerHTML.replace(/\n+$/, "").split("\n");
  term.innerHTML = source.map(function (html) {
    return '<span class="ln">' + html + "</span>";
  }).join("\n");
  var lines = Array.prototype.slice.call(term.querySelectorAll(".ln"));
  var verdict = document.getElementById("verdict-line");
  var run = 0;
  var timer = null;

  function delayAfter(line) {
    var text = line.textContent;
    if (text === "") return 60;
    if (text.indexOf("Casper checking") !== -1) return 700;
    if (text.indexOf("[model]") === 0) return 350;
    return 260;
  }

  function setCurrent(line) {
    lines.forEach(function (other) { other.classList.toggle("is-current", other === line); });
  }

  function typeInto(span, text, token, done) {
    var i = 0;
    span.textContent = "";
    (function step() {
      if (token !== run) return;
      i += 1;
      span.textContent = text.slice(0, i);
      if (i < text.length) timer = window.setTimeout(step, 24 + Math.random() * 40);
      else done();
    })();
  }

  function play() {
    run += 1;
    var token = run;
    window.clearTimeout(timer);
    term.setAttribute("aria-busy", "true");
    if (verdict) verdict.classList.remove("is-lit");
    lines.forEach(function (line) { line.classList.add("is-hidden"); line.classList.remove("is-current"); });
    var you = term.querySelector(".you");
    var typed = you ? you.textContent : "";
    if (you && you.dataset.full) typed = you.dataset.full;
    if (you) you.dataset.full = typed;

    var index = 0;
    (function next() {
      if (token !== run) return;
      if (index >= lines.length) {
        term.removeAttribute("aria-busy");
        if (verdict) verdict.classList.add("is-lit");
        return;
      }
      var line = lines[index];
      index += 1;
      line.classList.remove("is-hidden");
      setCurrent(line);
      if (you && line.contains(you)) {
        timer = window.setTimeout(function () {
          typeInto(you, typed, token, function () { timer = window.setTimeout(next, 450); });
        }, 400);
        return;
      }
      timer = window.setTimeout(next, delayAfter(line));
    })();
  }

  if (replayBtn) {
    replayBtn.hidden = false;
    replayBtn.addEventListener("click", play);
  }

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          observer.disconnect();
          play();
        }
      });
    }, { threshold: 0.35 });
    observer.observe(term);
  } else {
    play();
  }
})();
