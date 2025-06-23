const apps = [
  { id: "netflix", icon: "icons/netflix.png" },
  { id: "com.wbd.stream", icon: "icons/max.png" },
  { id: "com.apple.appletv", icon: "icons/apple.png" },
  { id: "amazon", icon: "icons/prime.png" },
  { id: "com.disney.disneyplus-prod", icon: "icons/disney.png" },
  { id: "stan.webos2", icon: "icons/stan.png" },
  { id: "binge", icon: "icons/binge.png" },
  { id: "abc", icon: "icons/abc.png" },
  { id: "sbs", icon: "icons/sbs.png" },
  { id: "com.swm.7plus", icon: "icons/7plus.png" },
  { id: "com.accedo.mi9.prod", icon: "icons/9now.png" },
  { id: "ten", icon: "icons/10play.png" },
  { id: "youtube.leanback.v4", icon: "icons/youtube.png" },
  { id: "spotify-beehive", icon: "icons/spotify.png" },
  { id: "justwatch", icon: "icons/justwatch.png" },
  { id: "com.webos.app.hdmi1", icon: "icons/windows11.png" },
];

const grid = document.getElementById("app-grid");
const gridColumns = 4;
const gridRows = Math.ceil(apps.length / gridColumns);
let cards = null;
let focusCardIndex = 0;
let focusedWithKey = false;

function renderGrid() {
  apps.forEach((app, index) => {
    const card = document.createElement("div");
    card.className = "app-card";
    card.tabIndex = 0;
    card.dataset.index = index;

    const img = document.createElement("img");
    img.className = "app-icon";
    img.src = app.icon;
    img.alt = app.id;

    card.appendChild(img);
    grid.appendChild(card);

    VanillaTilt.init(card, {
      reverse: true,
      max: 20,
      perspective: 500,
      scale: 1.33,
      speed: 1000,
      glare: true,
      "max-glare": 0.25,
    });

    card.addEventListener("click", () => launchApp(app));
    card.addEventListener("mouseenter", (event) => {
      card.focus();
      card.classList.add("focused");
      focusCardIndex = parseInt(event.target.dataset.index);
    });
    card.addEventListener("mouseleave", () => {
      card.classList.remove("focused");
    });
  });

  cards = document.querySelectorAll(".app-card");

  focusCard(0);
}

function focusCard(index) {
  unfocusCards();
  card = cards[index];
  card.focus();
  card.classList.add("focused");
  card.vanillaTilt.onMouseEnter(); // ensures the tilt animation runs correctly
  const centerX = card.vanillaTilt.left + card.vanillaTilt.width / 2;
  const centerY = card.vanillaTilt.top + card.vanillaTilt.height / 2;
  const direction = index % 2 === 0 ? 1 : -1;
  let angle = Math.random() * Math.PI * 2 * direction;
  card.dataset.focusTiltInterval = setInterval(() => {
    card.vanillaTilt.onMouseMove({
      clientX: centerX + (Math.cos(angle) * card.vanillaTilt.width) / 3,
      clientY: centerY + (Math.sin(angle) * card.vanillaTilt.height) / 3,
    }); // simulate mouse circling the card to achieve tilt animation
    // angle += 0.02 * direction;
    angle = (angle + 0.02 * direction + Math.PI * 2) % (Math.PI * 2);
  }, 33); // ≈30 FPS
  focusCardIndex = index;
  focusedWithKey = true;
}

function unfocusCards() {
  document.querySelectorAll(".app-card.focused").forEach((card) => {
    clearInterval(card.dataset.focusTiltInterval);
    delete card.dataset.focusTiltInterval;
    card.vanillaTilt.onMouseLeave(); // simulate mouse leaving the card to reset
    card.classList.remove("focused");
  });
  focusedWithKey = false;
}

function launchApp(app) {
  webOS.service.request("luna://com.webos.applicationManager", {
    method: "launch",
    parameters: { id: app.id },
  });
}

document.addEventListener("mousemove", () => {
  if (focusedWithKey) {
    unfocusCards();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    launchApp(apps[focusCardIndex]);
    return;
  }
  const row = Math.floor(focusCardIndex / gridColumns);
  const column = focusCardIndex % gridColumns;
  if (event.key === "ArrowRight") {
    focusCard((focusCardIndex + 1) % apps.length);
  } else if (event.key === "ArrowLeft") {
    focusCard((focusCardIndex - 1 + apps.length) % apps.length);
  } else if (event.key === "ArrowDown") {
    const belowCardIndex = ((row + 1) % gridRows) * gridColumns + column;
    focusCard(Math.min(belowCardIndex, apps.length - 1));
  } else if (event.key === "ArrowUp") {
    const aboveCardIndex =
      ((row - 1 + gridRows) % gridRows) * gridColumns + column;
    focusCard(Math.min(aboveCardIndex, apps.length - 1));
  }
});

// MQTT Connection
const indicator = document.getElementById("service-indicator");
const overlay = document.getElementById("overlay");
const logTextbox = overlay.querySelector(".logs-textbox");
let indicatorHovered = false;
let checkTimerMQTT = null;

function startMQTT() {
  try {
    webOS.service.request("luna://com.danvnest.applauncher+mqtt.service/", {
      method: "start",
      onFailure: function () {
        indicator.className = "failed";
      },
      onSuccess: function () {
        indicator.className = "success";
      },
    });
    checkMQTT();
  } catch {
    indicator.className = "failed";
  }
}

function checkMQTT() {
  try {
    webOS.service.request("luna://com.danvnest.applauncher+mqtt.service/", {
      method: "getState",
      onFailure: function () {
        indicator.className = "failed";
      },
      onSuccess: function () {
        indicator.className = "success";
      },
    });
  } catch {
    indicator.className = "failed";
  }
  if (overlay.className === "logs") {
    getLogsMQTT();
  }
  clearTimeout(checkTimerMQTT);
  checkTimerMQTT = setTimeout(checkMQTT, 10000);
}

function getLogsMQTT() {
  try {
    webOS.service.request("luna://com.danvnest.applauncher+mqtt.service/", {
      method: "getLogs",
      onFailure: handleGetLogsFailureMQTT,
      onSuccess: function (message) {
        if (message && message.logs) {
          logTextbox.textContent += JSON.stringify(message, null, 2) + "\n";
          if (message.logs.length === 0) {
            logTextbox.textContent += `${new Date().toISOString()} - No logs\n`;
          } else {
            message.logs.forEach((log) => {
              logTextbox.textContent += log + "\n";
            });
          }
          logTextbox.scrollTop = logTextbox.scrollHeight;
        } else {
          handleGetLogsFailureMQTT();
        }
      },
    });
  } catch {
    handleGetLogsFailureMQTT();
  }
}

function handleGetLogsFailureMQTT() {
  logTextbox.textContent += `${new Date().toISOString()} - Failed to get service logs\n`;
  logTextbox.scrollTop = logTextbox.scrollHeight;
  indicator.className = "failed";
}

overlay.addEventListener("click", (event) => {
  if (overlay.className === "logs" && !event.target.closest(".logs-textbox")) {
    overlay.className = "hidden";
  }
});

indicator.addEventListener("click", (event) => {
  if (indicator.matches(":hover")) {
    if (overlay.className !== "logs") {
      overlay.className = "logs";
      getLogsMQTT();
    } else {
      overlay.className = "hidden";
    }
  }
});

document.addEventListener("visibilitychange", function () {
  if (!document.hidden) {
    checkMQTT();
  } else {
    clearTimeout(checkTimerMQTT);
  }
});

// Startup
renderGrid();
startMQTT();
