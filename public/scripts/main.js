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

const rosterFilters = ['rosterSearch', 'rosterRankFilter', 'rosterHouseFilter', 'rosterActivityFilter'].map((id) => document.getElementById(id));
if (rosterFilters.every(Boolean)) {
  const applyRosterFilters = () => {
    const [search, rank, house, activity] = rosterFilters.map((field) => field.value.toLowerCase().trim());
    document.querySelectorAll('.roster-user-row').forEach((row) => {
      row.hidden = Boolean((search && !row.dataset.search.includes(search)) || (rank && row.dataset.rank.toLowerCase() !== rank) || (house && row.dataset.house.toLowerCase() !== house) || (activity && row.dataset.activity.toLowerCase() !== activity));
    });
  };
  rosterFilters.forEach((field) => field.addEventListener('input', applyRosterFilters));
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
let pendingLiveReload = false;

const isUserInteracting = () => {
  const active = document.activeElement;
  const tag = active?.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(active?.isContentEditable);
  const hasOpenDialog = Boolean(document.querySelector("dialog[open]"));
  const isDragging = Boolean(document.querySelector(".is-dragging"));
  return isInput || hasOpenDialog || isDragging;
};

const triggerOrScheduleReload = () => {
  if (Date.now() - lastLocalSaveTime < 3000) {
    return;
  }
  if (isUserInteracting()) {
    pendingLiveReload = true;
    return;
  }
  window.location.reload();
};

if (window.io && ["/roster", "/bingo", "/roster-planner", "/settings", "/reports", "/loa", "/feedback", "/dashboard", "/staff-guidelines", "/higher-guidelines"].includes(window.location.pathname)) {
  const liveSocket = window.io();
  liveSocket.on("data-updated", () => triggerOrScheduleReload());

  const handleInteractionEnd = () => {
    if (!pendingLiveReload) return;
    setTimeout(() => {
      if (pendingLiveReload && !isUserInteracting() && Date.now() - lastLocalSaveTime >= 1500) {
        pendingLiveReload = false;
        window.location.reload();
      }
    }, 300);
  };

  document.addEventListener("focusout", handleInteractionEnd);
  document.addEventListener("pointerup", handleInteractionEnd);
  document.addEventListener("keyup", handleInteractionEnd);
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
  const initial = escapeHtml((user.displayName || "?").trim().charAt(0).toUpperCase() || "?");
  const inner = user.avatarUrl
    ? `<img class="avatar-img" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.displayName)}" style="width:${size}px;height:${size}px;">`
    : `<span class="avatar-initials" style="width:${size}px;height:${size}px;font-size:${Math.floor(size / 2.2)}px;">${initial}</span>`;

  return `<span class="avatar-wrapper${online ? " is-online" : ""}" data-discord-id="${escapeHtml(user.discordId)}" style="width:${size}px;height:${size}px;" title="${escapeHtml(user.displayName)}">${inner}<span class="avatar-online-dot"></span></span>`;
};

// LIVE "WHO'S ONLINE" PRESENCE, POLLED WHILE THE ROSTER IS OPEN
const onlineNowBar = document.getElementById("onlineNowBar");

if (onlineNowBar) {
  const onlineNowAvatars = onlineNowBar.querySelector(".online-now-avatars");

  const refreshOnlineUsers = () => {
    if (!onlineNowAvatars) return;

    fetch("/api/online-users")
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

  setInterval(refreshOnlineUsers, 20000);
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
        hostTrainingComplete
        , lastPromotion
      } = button.dataset;

      if (viewUserTimeline) {
        const events = [{ date: hireDate, text: 'Joined Drowsy Vocals' }, { date: lastPromotion, text: 'Last promotion' }, { date: '', text: `Current activity: ${activity || 'Not assigned'}` }].filter((event) => event.date || event.text);
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

  input.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const row = input.closest("tr");
      const hpInput = row?.querySelector(".bingo-hp-input");
      const ccInput = row?.querySelector(".bingo-cc-input");
      if (!hpInput || !ccInput) return;

      fetch("/bingo/totals", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          discordId: input.dataset.discordId,
          hp: hpInput.value,
          cc: ccInput.value
        })
      }).catch(() => {});
    }, 700);
  });
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
