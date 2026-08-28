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

// LIVE "WHO'S ONLINE" PRESENCE, POLLED WHILE THE ROSTER IS OPEN
const onlineNowBar = document.getElementById("onlineNowBar");

if (onlineNowBar) {
  const escapeHtml = (str) => (str || "").toString().replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

  const renderAvatarHtml = (user, size) => {
    const initial = escapeHtml((user.displayName || "?").trim().charAt(0).toUpperCase() || "?");
    const inner = user.avatarUrl
      ? `<img class="avatar-img" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.displayName)}" style="width:${size}px;height:${size}px;">`
      : `<span class="avatar-initials" style="width:${size}px;height:${size}px;font-size:${Math.floor(size / 2.2)}px;">${initial}</span>`;

    return `<span class="avatar-wrapper is-online" data-discord-id="${escapeHtml(user.discordId)}" style="width:${size}px;height:${size}px;" title="${escapeHtml(user.displayName)}">${inner}<span class="avatar-online-dot"></span></span>`;
  };

  const refreshOnlineUsers = () => {
    fetch("/api/online-users")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Request failed"))))
      .then((payload) => {
        const onlineUsers = payload.onlineUsers || [];
        const label = onlineNowBar.querySelector(".online-now-label");

        onlineNowBar.innerHTML = "";
        if (label) onlineNowBar.appendChild(label);

        if (onlineUsers.length === 0) {
          const empty = document.createElement("span");
          empty.className = "online-now-empty";
          empty.textContent = "No one else online right now.";
          onlineNowBar.appendChild(empty);
        } else {
          onlineUsers.forEach((user) => {
            onlineNowBar.insertAdjacentHTML("beforeend", renderAvatarHtml(user, 32));
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
        shift
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
  const viewDisplayName = document.getElementById("viewDisplayName");
  const viewDiscordUser = document.getElementById("viewDiscordUser");
  const viewAccountType = document.getElementById("viewAccountType");
  const viewHouse = document.getElementById("viewHouse");
  const viewHousePoints = document.getElementById("viewHousePoints");

  viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const {
        displayName,
        discordUser,
        accountType,
        house,
        housePoints
      } = button.dataset;

      viewDisplayName.textContent = displayName || "";
      viewDiscordUser.textContent = discordUser || "";
      viewAccountType.textContent = accountType || "";
      viewHouse.textContent = house || "";
      viewHousePoints.textContent = housePoints || "0";

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