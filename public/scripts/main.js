var data = [
    [22, 'Working late'],
    [18, 'Good evening'],
    [12, 'Good afternoon'],
    [5,  'Good morning'],
    [0,  'Whoa, early bird']
],
hr = new Date().getHours();
for (var i = 0; i < data.length; i++) {
    if (hr >= data[i][0]) {
        console.log(data[i][1])
        break;
    }
}

const navMenuToggle = document.querySelector('.nav-menu-toggle');
const primaryNavigation = document.getElementById('primaryNavigation');
if (navMenuToggle && primaryNavigation) {
  navMenuToggle.addEventListener('click', () => {
    const isOpen = primaryNavigation.classList.toggle('is-open');
    navMenuToggle.setAttribute('aria-expanded', String(isOpen));
  });
}

const rosterFilters = ['rosterSearch', 'rosterRankFilter', 'rosterHouseFilter', 'rosterActivityFilter', 'rosterAlertFilter'].map((id) => document.getElementById(id));
if (rosterFilters.slice(0, 4).every(Boolean)) {
  const applyRosterFilters = () => {
    const search = (document.getElementById('rosterSearch')?.value || '').toLowerCase().trim();
    const rank = (document.getElementById('rosterRankFilter')?.value || '').toLowerCase().trim();
    const house = (document.getElementById('rosterHouseFilter')?.value || '').toLowerCase().trim();
    const activity = (document.getElementById('rosterActivityFilter')?.value || '').toLowerCase().trim();
    const alertFilter = (document.getElementById('rosterAlertFilter')?.value || '').toLowerCase().trim();

    document.querySelectorAll('.roster-user-row').forEach((row) => {
      const matchesSearch = !search || row.dataset.search.includes(search);
      const matchesRank = !rank || (row.dataset.rank || '').toLowerCase() === rank;
      const matchesHouse = !house || (row.dataset.house || '').toLowerCase() === house;
      const matchesActivity = !activity || (row.dataset.activity || '').toLowerCase() === activity;

      let matchesAlert = true;
      if (alertFilter === 'promo') {
        matchesAlert = Boolean(row.dataset.promotionReady);
      } else if (alertFilter === 'inactive') {
        matchesAlert = Boolean(row.dataset.inactiveRisk);
      }

      row.hidden = !(matchesSearch && matchesRank && matchesHouse && matchesActivity && matchesAlert);
    });

    document.querySelectorAll('.vacant-row').forEach((row) => {
      const matchesRank = !rank || (row.dataset.rank || '').toLowerCase() === rank;
      row.hidden = !matchesRank;
    });

    // Also hide rank headers if all rows under that rank are hidden
    document.querySelectorAll('.rank-group-header').forEach((header) => {
      const rankGroup = (header.dataset.rankGroup || '').toLowerCase();
      if (!rankGroup) return;
      const hasVisible = Array.from(document.querySelectorAll(`.roster-user-row[data-rank="${rankGroup}"], .vacant-row[data-rank="${rankGroup}"]`)).some((r) => !r.hidden);
      header.hidden = !hasVisible;
    });
  };
  rosterFilters.filter(Boolean).forEach((field) => {
    field.addEventListener('input', applyRosterFilters);
    field.addEventListener('change', applyRosterFilters);
  });
}

document.querySelectorAll('.nav-notifications-trigger, .nav-account-trigger, .nav-guidelines-trigger').forEach((trigger) => {
  trigger.addEventListener('click', () => {
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!menu) return;
    const isOpen = menu.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', String(isOpen));
  });
});

// REFRESH SHARED DATA VIEWS WHEN ANOTHER USER SAVES A CHANGE.
let lastLocalSaveTime = 0;
let lastUserInputTime = 0;
let pendingLiveReload = false;

// Track user input/typing globally so live reload never interrupts active typing or interaction
document.addEventListener("input", () => {
  lastUserInputTime = Date.now();
}, true);

document.addEventListener("keydown", () => {
  lastUserInputTime = Date.now();
}, true);

document.addEventListener("submit", () => {
  lastLocalSaveTime = Date.now();
  lastUserInputTime = Date.now();
}, true);

const isUserInteracting = () => {
  const active = document.activeElement;
  const tag = active?.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(active?.isContentEditable);
  const hasOpenDialog = Boolean(document.querySelector("dialog[open]"));
  const isDragging = Boolean(document.querySelector(".is-dragging"));
  const typedRecently = (Date.now() - lastUserInputTime) < 5000;
  const savedRecently = (Date.now() - lastLocalSaveTime) < 5000;
  return isInput || hasOpenDialog || isDragging || typedRecently || savedRecently;
};

const triggerOrScheduleReload = () => {
  if (isUserInteracting()) {
    pendingLiveReload = true;
    return;
  }
  window.location.reload();
};

if (window.io && ["/roster", "/events", "/bingo", "/roster-planner", "/settings", "/reports", "/loa", "/feedback", "/dashboard", "/staff-guidelines", "/higher-guidelines"].includes(window.location.pathname)) {
  const liveSocket = window.io();
  liveSocket.on("data-updated", () => triggerOrScheduleReload());

  // Periodically check if there's a pending reload once the user is completely idle
  setInterval(() => {
    if (pendingLiveReload && !isUserInteracting()) {
      pendingLiveReload = false;
      window.location.reload();
    }
  }, 2000);
}

// SHARED AVATAR RENDERING HELPERS (USED BY THE ONLINE-NOW BAR AND VIEW-USER POPUP)
const escapeHtml = (str) => (str || "").toString().replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const renderAvatarHtml = (user, size, online) => {
  const initial = escapeHtml((user.displayName || user.discordUser || user.discordId || "?").trim().charAt(0).toUpperCase() || "?");
  const fontSize = Math.floor(size / 2.2);
  const initialsHtml = `<span class="avatar-initials" style="${user.avatarUrl ? 'display:none;' : ''}width:${size}px;height:${size}px;font-size:${fontSize}px;">${initial}</span>`;
  const imgHtml = user.avatarUrl
    ? `<img class="avatar-img" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.displayName)}" style="width:${size}px;height:${size}px;" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex';">`
    : '';

  return `<span class="avatar-wrapper${online ? " is-online" : ""}" data-discord-id="${escapeHtml(user.discordId)}" style="width:${size}px;height:${size}px;" title="${escapeHtml(user.displayName)}">${imgHtml}${initialsHtml}<span class="avatar-online-dot"></span></span>`;
};

// GLOBAL PRESENCE HEARTBEAT (KEEPS ACTIVE USERS ONLINE ACROSS ALL PAGES)
const sendPresencePing = () => {
  fetch("/api/online-users", { cache: "no-store" }).catch(() => {});
};

// Periodic heartbeat every 45s (well within 2 minute cutoff)
setInterval(sendPresencePing, 45000);

// Ping on tab regain focus / visibility change
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    sendPresencePing();
  }
});

// LIVE "WHO'S ONLINE" PRESENCE, POLLED WHILE THE ROSTER IS OPEN
const onlineNowBar = document.getElementById("onlineNowBar");

if (onlineNowBar) {
  const onlineNowAvatars = onlineNowBar.querySelector(".online-now-avatars");

  const refreshOnlineUsers = () => {
    if (!onlineNowAvatars) return;

    fetch("/api/online-users", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Request failed"))))
      .then((payload) => {
        const onlineUsers = payload.onlineUsers || [];

        onlineNowAvatars.innerHTML = "";

        if (onlineUsers.length === 0) {
          const empty = document.createElement("span");
          empty.className = "online-now-empty";
          empty.textContent = "No one else online right now.";
          onlineNowAvatars.appendChild(empty);
        } else {
          onlineUsers.forEach((user) => {
            onlineNowAvatars.insertAdjacentHTML("beforeend", renderAvatarHtml(user, 32, true));
          });
        }

        document.querySelectorAll(".roster-content table .avatar-wrapper").forEach((el) => {
          const isOnline = onlineUsers.some((user) => user.discordId === el.dataset.discordId);
          el.classList.toggle("is-online", isOnline);
        });
      })
      .catch(() => {});
  };

  // Run immediately on page load and poll every 15s
  refreshOnlineUsers();
  setInterval(refreshOnlineUsers, 15000);
}


const addUserPopup = document.getElementById("addUserPopup");
const openAddUserPopup = document.getElementById("openAddUserPopup");
const closeAddUserPopup = document.getElementById("closeAddUserPopup");
const editUserPopup = document.getElementById("editUserPopup");
const closeEditUserPopup = document.getElementById("closeEditUserPopup");
const promoteUserPopup = document.getElementById("promoteUserPopup");
const closePromoteUserPopup = document.getElementById("closePromoteUserPopup");
const viewUserPopup = document.getElementById("viewUserPopup");
const closeViewUserPopup = document.getElementById("closeViewUserPopup");

if (addUserPopup && openAddUserPopup && closeAddUserPopup) {
  // Add user button opens a modal dialog.
  openAddUserPopup.addEventListener("click", () => {
    addUserPopup.returnValue = "";
    addUserPopup.showModal();
  });

  // Close button closes the dialog box.
  closeAddUserPopup.addEventListener("click", () => {
    addUserPopup.close();
  });

  // Form close logs an event for debugging modal flow.
  addUserPopup.addEventListener("close", () => {
    console.log(`Dialog closed. Return value: "${addUserPopup.returnValue}"`);
  });
}

if (editUserPopup && closeEditUserPopup) {
  const editButtons = document.querySelectorAll(".editBtn");
  const editOriginalDiscordId = document.getElementById("editOriginalDiscordId");
  const editDiscordId = document.getElementById("editDiscordId");
  const editDisplayName = document.getElementById("editDisplayName");
  const editDiscordUser = document.getElementById("editDiscordUser");
  const editAccountType = document.getElementById("editAccountType");
  const editHireDate = document.getElementById("editHireDate");
  const editHouse = document.getElementById("editHouse");
  const editHousePoints = document.getElementById("editHousePoints");
  const editActivity = document.getElementById("editActivity");
  const editWeeksActivity = document.getElementById("editWeeksActivity");
  const editShift = document.getElementById("editShift");
  const editPassword = document.getElementById("editPassword");
  const editOnboardingComplete = document.getElementById("editOnboardingComplete");
  const editHostTrainingComplete = document.getElementById("editHostTrainingComplete");

  editButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const {
        discordId,
        displayName,
        discordUser,
        accountType,
        hireDate,
        house,
        housePoints,
        activity,
        weeksActivity,
        shift,
        onboardingComplete,
        hostTrainingComplete
      } = button.dataset;

      editOriginalDiscordId.value = discordId || "";
      editDiscordId.value = discordId || "";
      editDisplayName.value = displayName || "";
      editDiscordUser.value = discordUser || "";
      editAccountType.value = accountType || "Tired Esquire";
      editHireDate.value = hireDate || "";
      editHouse.value = house || "Stubo United";
      editHousePoints.value = housePoints || 0;
      editActivity.value = activity || "Active";
      editWeeksActivity.value = weeksActivity || 0;
      editShift.value = shift || "NA";
      editPassword.value = "";
      editOnboardingComplete.checked = Boolean(onboardingComplete);
      editHostTrainingComplete.checked = Boolean(hostTrainingComplete);

      editUserPopup.returnValue = "";
      editUserPopup.showModal();
    });
  });

  closeEditUserPopup.addEventListener("click", () => {
    editUserPopup.close();
  });
}
if (viewUserPopup && closeViewUserPopup) {
  const viewButtons = document.querySelectorAll(".viewBtn");
  const viewAvatar = document.getElementById("viewAvatar");
  const viewDisplayName = document.getElementById("viewDisplayName");
  const viewDiscordUser = document.getElementById("viewDiscordUser");
  const viewDiscordId = document.getElementById("viewDiscordId");
  const viewAccountType = document.getElementById("viewAccountType");
  const viewHouse = document.getElementById("viewHouse");
  const viewHousePoints = document.getElementById("viewHousePoints");
  const viewShift = document.getElementById("viewShift");
  const viewActivity = document.getElementById("viewActivity");
  const viewWeeksActivity = document.getElementById("viewWeeksActivity");
  const viewHireDate = document.getElementById("viewHireDate");
  const viewOnboarding = document.getElementById("viewOnboarding");
  const viewHostTraining = document.getElementById("viewHostTraining");
  const viewPromotionStatus = document.getElementById("viewPromotionStatus");
  const viewInactivityStatus = document.getElementById("viewInactivityStatus");
  const viewUserTimeline = document.getElementById("viewUserTimeline");

  viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const {
        discordId,
        displayName,
        discordUser,
        accountType,
        house,
        housePoints,
        shift,
        activity,
        weeksActivity,
        hireDate,
        avatarUrl,
        onboardingComplete,
        hostTrainingComplete,
        lastPromotion,
        timeInGrade,
        minDaysRequired,
        promotionReady,
        inactiveRisk,
        inactivityReason,
        daysSinceSeen,
        consecutiveMissed
      } = button.dataset;

      if (viewUserTimeline) {
        const events = [
          { date: hireDate, text: 'Joined Drowsy Vocals' },
          { date: lastPromotion, text: 'Last promotion' },
          { date: '', text: `Current activity: ${activity || 'Not assigned'}` }
        ].filter((event) => event.date || event.text);
        viewUserTimeline.innerHTML = events.map((event) => `<li><strong>${escapeHtml(event.date || 'Current')}</strong> ${escapeHtml(event.text)}</li>`).join('');
      }

      if (viewAvatar) {
        viewAvatar.innerHTML = renderAvatarHtml({ discordId, displayName, avatarUrl }, 96, false);
      }

      viewDisplayName.textContent = displayName || "";
      viewDiscordUser.textContent = discordUser || "";
      viewDiscordId.textContent = discordId || "";
      viewAccountType.textContent = accountType || "";
      viewHouse.textContent = house || "";
      viewHousePoints.textContent = housePoints || "0";
      viewShift.textContent = shift || "";
      viewActivity.textContent = activity || "";
      viewWeeksActivity.textContent = weeksActivity || "0";
      viewHireDate.textContent = hireDate || "";
      viewOnboarding.textContent = onboardingComplete ? "Complete" : "Pending";
      viewHostTraining.textContent = hostTrainingComplete ? "Complete" : "Pending";

      if (viewPromotionStatus) {
        if (promotionReady) {
          viewPromotionStatus.innerHTML = `<span style="color:#10b981;font-weight:bold;">🚀 Ready for promotion (${timeInGrade || 0} / ${minDaysRequired || 0} days in grade)</span>`;
        } else if (minDaysRequired) {
          viewPromotionStatus.textContent = `${timeInGrade || 0} / ${minDaysRequired} days in grade required`;
        } else {
          viewPromotionStatus.textContent = `${timeInGrade || 0} days in grade (No promotion requirement)`;
        }
      }

      if (viewInactivityStatus) {
        if (inactiveRisk) {
          viewInactivityStatus.innerHTML = `<span style="color:#ef4444;font-weight:bold;">⚠️ Alert: ${escapeHtml(inactivityReason || 'Inactivity Warning')}</span>`;
        } else {
          const seenText = daysSinceSeen ? `Last seen ${daysSinceSeen}d ago` : 'Active / Recently seen';
          viewInactivityStatus.textContent = `Good standing (${seenText})`;
        }
      }

      viewUserPopup.showModal();
    });
  });

  closeViewUserPopup.addEventListener("click", () => {
    viewUserPopup.close();
  });
}

const addStrikePopup = document.getElementById("addStrikePopup");
const closeAddStrikePopup = document.getElementById("closeAddStrikePopup");

if (addStrikePopup && closeAddStrikePopup) {
  const strikeButtons = document.querySelectorAll(".strikeBtn");
  const strikeDiscordId = document.getElementById("strikeDiscordId");
  const strikeDisplayName = document.getElementById("strikeDisplayName");
  const strikeCount = document.getElementById("strikeCount");
  const strikeReason = document.getElementById("strikeReason");
  const manageStrikesList = document.getElementById("manageStrikesList");

  strikeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const { discordId, displayName, strikes } = button.dataset;

      strikeDiscordId.value = discordId || "";
      strikeDisplayName.value = displayName || "";
      strikeCount.value = "1";
      strikeReason.value = "";

      if (manageStrikesList) {
        manageStrikesList.innerHTML = "";

        let strikeList = [];
        try {
          strikeList = strikes ? JSON.parse(strikes) : [];
        } catch (error) {
          strikeList = [];
        }

        if (strikeList.length === 0) {
          const li = document.createElement("li");
          li.textContent = "No strikes on record.";
          manageStrikesList.appendChild(li);
        } else {
          strikeList.forEach((strike) => {
            const li = document.createElement("li");
            const date = strike.date ? strike.date.slice(0, 10) : "Unknown date";

            const label = document.createElement("span");
            label.textContent = `${date} - ${strike.count} strike(s): ${strike.reason}`;

            const removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.textContent = "Remove";
            removeButton.addEventListener("click", () => {
              removeStrike(discordId, strike.id);
            });

            li.appendChild(label);
            li.appendChild(removeButton);
            manageStrikesList.appendChild(li);
          });
        }
      }

      addStrikePopup.returnValue = "";
      addStrikePopup.showModal();
    });
  });

  closeAddStrikePopup.addEventListener("click", () => {
    addStrikePopup.close();
  });
}

if (promoteUserPopup && closePromoteUserPopup) {
  const promoteButtons = document.querySelectorAll(".promoteBtn");
  const demoteButtons = document.querySelectorAll(".demoteBtn");
  const rankActionType = document.getElementById("rankActionType");
  const promoteDiscordId = document.getElementById("promoteDiscordId");
  const promoteDisplayName = document.getElementById("promoteDisplayName");
  const currentRank = document.getElementById("currentRank");
  const promoteAccountType = document.getElementById("promoteAccountType");
  const effectiveDate = document.getElementById("effectiveDate");
  const rankOrder = window.APP_RANKS || [
    "Mr. Sandman",
    "Realm God",
    "Dreamy Defender",
    "Dreamland Guard",
    "Nighty Knights",
    "Tired Esquire"
  ];

  const openRankDialog = (discordId, displayName, accountType, actionType) => {
    promoteDiscordId.value = discordId || "";
    promoteDisplayName.value = displayName || "";
    currentRank.value = accountType || "";
    rankActionType.value = actionType;

    let targetRank = accountType || "Tired Esquire";
    const currentIndex = rankOrder.indexOf(accountType || "");
    if (actionType === "demote" && currentIndex >= 0 && currentIndex < rankOrder.length - 1) {
      targetRank = rankOrder[currentIndex + 1];
    }
    if (actionType === "promote" && currentIndex > 0) {
      targetRank = rankOrder[currentIndex - 1];
    }

    promoteAccountType.value = targetRank;
    effectiveDate.value = new Date().toISOString().slice(0, 10);

    promoteUserPopup.returnValue = "";
    promoteUserPopup.showModal();
  };

  promoteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const { discordId, displayName, accountType } = button.dataset;
      openRankDialog(discordId, displayName, accountType, "promote");
    });
  });

  demoteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const { discordId, displayName, accountType } = button.dataset;
      openRankDialog(discordId, displayName, accountType, "demote");
    });
  });

  closePromoteUserPopup.addEventListener("click", () => {
    promoteUserPopup.close();
  });
}

const rosterPlanner = document.getElementById("rosterPlanner");

if (rosterPlanner) {
  const plannerForm = document.getElementById("rosterPlanForm");
  const assignmentsInput = document.getElementById("rosterPlanAssignments");
  let draggedUser = null;

  const updateLaneCounts = () => {
    rosterPlanner.querySelectorAll(".planner-lane").forEach((lane) => {
      const count = lane.querySelectorAll(".planner-user").length;
      const countLabel = lane.querySelector(".planner-count");
      if (countLabel) countLabel.textContent = `${count} assigned`;
    });
  };

  rosterPlanner.querySelectorAll(".planner-user").forEach((user) => {
    user.addEventListener("dragstart", () => {
      draggedUser = user;
      user.classList.add("is-dragging");
    });
    user.addEventListener("dragend", () => {
      draggedUser = null;
      user.classList.remove("is-dragging");
      rosterPlanner.querySelectorAll(".planner-dropzone").forEach((zone) => zone.classList.remove("is-drag-over"));
      updateLaneCounts();
    });
  });

  rosterPlanner.querySelectorAll(".planner-dropzone").forEach((zone) => {
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-drag-over"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      if (draggedUser) zone.appendChild(draggedUser);
      zone.classList.remove("is-drag-over");
      updateLaneCounts();
    });
  });

  plannerForm.addEventListener("submit", () => {
    const assignments = [];
    rosterPlanner.querySelectorAll(".planner-dropzone").forEach((zone) => {
      zone.querySelectorAll(".planner-user").forEach((user) => {
        assignments.push({
          discordId: user.dataset.discordId,
          accountType: zone.dataset.rank
        });
      });
    });
    assignmentsInput.value = JSON.stringify(assignments);
  });
}

document.querySelectorAll(".bingo-total-input").forEach((input) => {
  let saveTimer;

  const saveTotals = () => {
    clearTimeout(saveTimer);
    const row = input.closest("tr");
    const hpInput = row?.querySelector(".bingo-hp-input");
    const ccInput = row?.querySelector(".bingo-cc-input");
    if (!hpInput || !ccInput) return;

    lastLocalSaveTime = Date.now();
    lastUserInputTime = Date.now();

    fetch("/bingo/totals", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: new URLSearchParams({
        discordId: input.dataset.discordId,
        hp: hpInput.value,
        cc: ccInput.value
      })
    }).catch(() => {});
  };

  input.addEventListener("input", () => {
    lastUserInputTime = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveTotals, 1500);
  });

  input.addEventListener("change", saveTotals);
  input.addEventListener("blur", saveTotals);
});

const guidelinesEditToggle = document.querySelector("[data-guidelines-edit]");
const guidelinesEditor = document.querySelector(".guidelines-editor");
const guidelinesCancel = document.querySelector("[data-guidelines-cancel]");

if (guidelinesEditToggle && guidelinesEditor) {
  guidelinesEditToggle.addEventListener("click", () => {
    guidelinesEditor.hidden = false;
    guidelinesEditToggle.hidden = true;
    guidelinesEditor.querySelector("[contenteditable]")?.focus();
  });

  guidelinesCancel?.addEventListener("click", () => {
    guidelinesEditor.hidden = true;
    guidelinesEditToggle.hidden = false;
  });

  guidelinesEditor.querySelectorAll("[data-guidelines-command]").forEach((button) => {
    button.addEventListener("click", () => {
      document.execCommand(button.dataset.guidelinesCommand, false);
      guidelinesEditor.querySelector("[contenteditable]")?.focus();
    });
  });

  guidelinesEditor.querySelector("[data-guidelines-format]")?.addEventListener("change", (event) => {
    document.execCommand("formatBlock", false, event.target.value);
  });

  guidelinesEditor.querySelector("[data-guidelines-size]")?.addEventListener("change", (event) => {
    document.execCommand("fontSize", false, event.target.value);
  });

  guidelinesEditor.querySelector("[data-guidelines-color]")?.addEventListener("input", (event) => {
    document.execCommand("foreColor", false, event.target.value);
  });

  guidelinesEditor.querySelector("[data-guidelines-highlight]")?.addEventListener("input", (event) => {
    document.execCommand("hiliteColor", false, event.target.value);
  });

  guidelinesEditor.querySelector("[data-guidelines-link]")?.addEventListener("click", () => {
    const url = window.prompt("Link URL");
    if (url) document.execCommand("createLink", false, url);
  });

  guidelinesEditor.addEventListener("submit", () => {
    const editor = guidelinesEditor.querySelector("[contenteditable]");
    const content = guidelinesEditor.querySelector("[data-guidelines-content]");
    if (editor && content) content.value = editor.innerHTML;
  });
}

document.querySelectorAll(".nav-account-trigger").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const menu = trigger.closest(".nav-account-menu");
    const isOpen = menu.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(isOpen));
  });
});

document.querySelectorAll(".nav-guidelines-trigger").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const menu = trigger.closest(".nav-guidelines-menu");
    const isOpen = menu.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(isOpen));
  });
});

// EVENTS SCHEDULE TIMEZONE & LOCALIZATION
const initEventsLocalization = () => {
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  
  // Display user's timezone in header badge and form hint
  const tzEl = document.getElementById('eventsUserTimezone');
  if (tzEl) tzEl.textContent = userTimezone;

  const offsetEl = document.getElementById('eventsUserOffset');
  if (offsetEl) {
    try {
      const now = new Date();
      const shortTz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value || '';
      offsetEl.textContent = shortTz ? `(${shortTz})` : '';
    } catch (_) {}
  }

  document.querySelectorAll('.form-user-tz').forEach((el) => {
    el.textContent = userTimezone;
  });

  // Localize upcoming event times
  document.querySelectorAll('.event-time-display').forEach((el) => {
    const startIso = el.dataset.eventStart;
    const endIso = el.dataset.eventEnd;
    if (!startIso) return;

    const startDate = new Date(startIso);
    if (isNaN(startDate.getTime())) return;

    const endDate = endIso ? new Date(endIso) : null;
    const now = new Date();

    const primaryEl = el.querySelector('.event-time-primary');
    const secondaryEl = el.querySelector('.event-time-secondary');
    const relativeEl = el.querySelector('.event-time-relative');

    // Localized formatted date and time in user's locale
    const startStr = startDate.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    if (primaryEl) {
      primaryEl.textContent = startStr;
    }

    if (secondaryEl) {
      if (endDate && !isNaN(endDate.getTime())) {
        const sameDay = startDate.toDateString() === endDate.toDateString();
        const endStr = sameDay
          ? endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
          : endDate.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        secondaryEl.textContent = `until ${endStr}`;
      } else {
        secondaryEl.textContent = '';
      }
    }

    if (relativeEl) {
      const diffMs = startDate.getTime() - now.getTime();
      const isPast = endDate ? (now.getTime() > endDate.getTime()) : (diffMs < -7200000);
      const isLive = now.getTime() >= startDate.getTime() && (endDate ? now.getTime() <= endDate.getTime() : diffMs >= -7200000);

      if (isLive) {
        relativeEl.textContent = '🔴 Live Now';
        relativeEl.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
        relativeEl.style.color = '#ef4444';
        relativeEl.style.border = '1px solid rgba(239, 68, 68, 0.5)';
      } else if (isPast) {
        relativeEl.textContent = 'Concluded';
        relativeEl.style.backgroundColor = 'rgba(100, 100, 100, 0.2)';
        relativeEl.style.color = '#8e897e';
        relativeEl.style.border = '1px solid rgba(100, 100, 100, 0.4)';
      } else {
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        let badgeText = '';
        if (diffHours < 1) {
          const diffMins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
          badgeText = `Starts in ${diffMins}m`;
        } else if (diffHours < 24) {
          badgeText = `Starts in ${diffHours}h`;
        } else {
          badgeText = `In ${diffDays} day${diffDays === 1 ? '' : 's'}`;
        }
        relativeEl.textContent = `⏳ ${badgeText}`;
        relativeEl.style.backgroundColor = 'rgba(251, 191, 36, 0.15)';
        relativeEl.style.color = '#fbbf24';
        relativeEl.style.border = '1px solid rgba(251, 191, 36, 0.4)';
      }
    }
  });

  // Localize past archive times
  document.querySelectorAll('.past-event-time').forEach((el) => {
    const startIso = el.dataset.eventStart;
    if (!startIso) return;
    const startDate = new Date(startIso);
    if (!isNaN(startDate.getTime())) {
      const dateStr = startDate.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
      const timeStr = startDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      });
      el.textContent = `${dateStr} at ${timeStr}`;
    }
  });

  // Handle Event Creation Form: compute UTC ISO strings based on local browser date/time inputs
  const createEventForm = document.getElementById('createEventForm');
  if (createEventForm) {
    createEventForm.addEventListener('submit', () => {
      const startDateVal = document.getElementById('eventStartDate')?.value;
      const startTimeVal = document.getElementById('eventStartTime')?.value;
      const endDateVal = document.getElementById('eventEndDate')?.value;
      const endTimeVal = document.getElementById('eventEndTime')?.value;

      const parseInputToIso = (dStr, tStr) => {
        if (!dStr || !tStr) return null;
        const [y, m, d] = dStr.split('-').map(Number);
        const [h, min] = tStr.split(':').map(Number);
        if (!y || !m || !d || isNaN(h) || isNaN(min)) return null;
        const local = new Date(y, m - 1, d, h, min, 0, 0);
        return isNaN(local.getTime()) ? null : local.toISOString();
      };

      const startIso = parseInputToIso(startDateVal, startTimeVal);
      const endIso = parseInputToIso(endDateVal, endTimeVal);

      const startIsoInput = document.getElementById('eventStartIso');
      const endIsoInput = document.getElementById('eventEndIso');
      const tzInput = document.getElementById('eventClientTimezone');

      if (startIsoInput && startIso) startIsoInput.value = startIso;
      if (endIsoInput && endIso) endIsoInput.value = endIso;
      if (tzInput) tzInput.value = userTimezone;
    });
  }
};

initEventsLocalization();
