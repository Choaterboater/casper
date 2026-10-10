// Casper site: home page extras (index.html only). The page works without this file:
// then both install commands and every demo run simply show, one after another.
//  1. Tabs: install commands (macOS / Linux, Windows) and the demo runs.
//  2. Ghost eyes follow the pointer (not with reduced motion).
//  3. Demo replay: the chosen run types itself out, then the next one plays. Picking a tab
//     stops the rotation. With reduced motion every run shows finished and nothing rotates.
(function () {
  "use strict";
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 1. Tabs --------------------------------------------------------------
  // Wires a role="tablist" whose tabs point at panels with aria-controls.
  // Returns select(index, byUser); onSelect(index, byUser) runs after each switch.
  function makeTabs(tablist, onSelect) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    function select(index, byUser, focus) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tabs[index].focus();
      // A tab row that scrolls sideways (phones) keeps the chosen tab in view.
      if (tablist.scrollWidth > tablist.clientWidth) {
        var tab = tabs[index];
        var left = tab.offsetLeft;
        var right = left + tab.offsetWidth;
        if (left < tablist.scrollLeft || right > tablist.scrollLeft + tablist.clientWidth) {
          tablist.scrollLeft = Math.max(0, left - 16);
        }
      }
      if (onSelect) onSelect(index, byUser);
    }
    tabs.forEach(function (tab, index) {
      var panel = document.getElementById(tab.getAttribute("aria-controls"));
      if (panel) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tab.id);
      }
      tab.addEventListener("click", function () { select(index, true, false); });
      tab.addEventListener("keydown", function (event) {
        var next = -1;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next !== -1) {
          event.preventDefault();
          select(next, true, true);
        }
      });
    });
    tablist.hidden = false;
    return { select: select, count: tabs.length };
  }

  var install = document.getElementById("install");
  var installTabs = install && install.querySelector('[role="tablist"]');
  if (installTabs) {
    install.classList.add("is-tabbed");
    makeTabs(installTabs).select(0, false, false);
  }

  // 2. Ghost eyes --------------------------------------------------------
  var ghost = document.querySelector(".ghost-svg");
  var eyes = document.querySelectorAll(".ghost-eye");
  if (ghost && eyes.length && !reduceMotion) {
    var pointer = null;
    var scheduled = false;
    var MAX = 2; // SVG units
    window.addEventListener("pointermove", function (event) {
      pointer = { x: event.clientX, y: event.clientY };
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        var box = ghost.getBoundingClientRect();
        var dx = pointer.x - (box.left + box.width / 2);
        var dy = pointer.y - (box.top + box.height * 0.42);
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var reach = Math.min(1, dist / 240);
        var tx = ((dx / dist) * MAX * reach).toFixed(2);
        var ty = ((dy / dist) * MAX * reach).toFixed(2);
        Array.prototype.forEach.call(eyes, function (eye) {
          eye.setAttribute("transform", "translate(" + tx + " " + ty + ")");
        });
      });
    }, { passive: true });
  }

  // 3. Demo replay -------------------------------------------------------
  var demo = document.getElementById("demo");
  var demoTabs = demo && demo.querySelector('[role="tablist"]');
  if (!demoTabs) return;
  var panels = Array.prototype.slice.call(demo.querySelectorAll(".demo-panel"));
  var replayBtn = demo.querySelector(".replay-btn");
  demo.classList.add("js-tabs");

  // Each capture line holds whole spans, so splitting on newlines keeps valid HTML.
  var runs = panels.map(function (panel) {
    var term = panel.querySelector("pre.term");
    if (!reduceMotion) {
      term.innerHTML = term.innerHTML.replace(/\n+$/, "").split("\n").map(function (html) {
        return '<span class="ln">' + html + "</span>";
      }).join("\n");
    }
    var you = term.querySelector(".you");
    return {
      term: term,
      lines: Array.prototype.slice.call(term.querySelectorAll(".ln")),
      you: you,
      typed: you ? you.textContent : ""
    };
  });

  var token = 0;
  var timer = null;
  var rotating = !reduceMotion;
  var current = 0;
  var started = false;

  function delayAfter(text) {
    if (text === "") return 70;
    if (/running tests|Casper checking|Getting packages|^Checking /.test(text)) return 750;
    if (/^\s{2}\S.*…$/.test(text)) return 420;
    if (/^\[model\]/.test(text)) return 350;
    if (/^Make this change\?$/.test(text)) return 700;
    return 170;
  }

  function stop() {
    token += 1;
    window.clearTimeout(timer);
  }

  function showAll(run) {
    run.lines.forEach(function (line) { line.classList.remove("is-hidden", "is-current"); });
    if (run.you) run.you.textContent = run.typed;
    run.term.removeAttribute("aria-busy");
  }

  function play(index) {
    stop();
    var mine = token;
    var run = runs[index];
    if (reduceMotion || !run.lines.length) {
      showAll(run);
      return;
    }
    run.term.setAttribute("aria-busy", "true");
    run.lines.forEach(function (line) { line.classList.add("is-hidden"); line.classList.remove("is-current"); });
    var i = 0;
    function setCurrent(line) {
      run.lines.forEach(function (other) { other.classList.toggle("is-current", other === line); });
    }
    function next() {
      if (mine !== token) return;
      if (i >= run.lines.length) {
        run.term.removeAttribute("aria-busy");
        if (rotating) {
          timer = window.setTimeout(function () {
            if (mine === token) tabs.select((current + 1) % runs.length, false, false);
          }, 3800);
        }
        return;
      }
      var line = run.lines[i];
      i += 1;
      line.classList.remove("is-hidden");
      setCurrent(line);
      if (run.you && line.contains(run.you)) {
        var n = 0;
        run.you.textContent = "";
        timer = window.setTimeout(function type() {
          if (mine !== token) return;
          n += 1;
          run.you.textContent = run.typed.slice(0, n);
          if (n < run.typed.length) timer = window.setTimeout(type, 22 + Math.random() * 38);
          else timer = window.setTimeout(next, 450);
        }, 350);
        return;
      }
      timer = window.setTimeout(next, delayAfter(line.textContent));
    }
    next();
  }

  var tabs = makeTabs(demoTabs, function (index, byUser) {
    if (byUser) rotating = false;
    current = index;
    // Leave the other runs finished, so a run never shows half-typed after a switch.
    runs.forEach(function (run, i) { if (i !== index) showAll(run); });
    if (started) play(index);
  });
  tabs.select(0, false, false);

  if (replayBtn) {
    replayBtn.hidden = reduceMotion;
    replayBtn.addEventListener("click", function () {
      rotating = false;
      started = true;
      play(current);
    });
  }

  function start() {
    if (started) return;
    started = true;
    play(current);
  }
  if (reduceMotion) {
    runs.forEach(showAll);
  } else if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          observer.disconnect();
          start();
        }
      });
    }, { threshold: 0.3 });
    observer.observe(demo);
  } else {
    start();
  }
})();
