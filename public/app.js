(function () {
  const page = document.body.dataset.page;
  const authTokenKey = "livechat:token";

  function getToken() {
    return localStorage.getItem(authTokenKey) || "";
  }

  function setToken(token) {
    localStorage.setItem(authTokenKey, token);
  }

  function clearToken() {
    localStorage.removeItem(authTokenKey);
  }

  function setupStatusBar() {
    const statusBar = document.getElementById("statusBar");

    function setStatus(message, kind = "default") {
      if (!statusBar) {
        return;
      }

      if (!message) {
        statusBar.classList.add("hidden");
        statusBar.textContent = "";
        return;
      }

      statusBar.classList.remove("hidden");
      statusBar.textContent = message;

      if (kind === "error") {
        statusBar.style.borderColor = "rgba(184, 50, 50, 0.24)";
        statusBar.style.background = "rgba(255, 236, 236, 0.95)";
      } else if (kind === "success") {
        statusBar.style.borderColor = "rgba(46, 125, 79, 0.24)";
        statusBar.style.background = "rgba(236, 250, 241, 0.95)";
      } else {
        statusBar.style.borderColor = "rgba(191, 91, 49, 0.18)";
        statusBar.style.background = "rgba(255, 244, 233, 0.92)";
      }
    }

    return { setStatus };
  }

  async function apiRequest(url, options = {}) {
    const token = getToken();
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "요청 처리 중 오류가 발생했습니다.");
    }

    return data;
  }

  async function restoreUser() {
    const token = getToken();
    if (!token) {
      return null;
    }

    try {
      const data = await apiRequest("/api/auth/me");
      return data.user;
    } catch (error) {
      clearToken();
      return null;
    }
  }

  if (page === "landing") {
    restoreUser().then((user) => {
      if (user) {
        window.location.replace("/chat.html");
      }
    });
    return;
  }

  if (page === "login") {
    const { setStatus } = setupStatusBar();
    const usernameInput = document.getElementById("loginUsername");
    const passwordInput = document.getElementById("loginPassword");
    const loginBtn = document.getElementById("loginBtn");

    restoreUser().then((user) => {
      if (user) {
        window.location.replace("/chat.html");
      }
    });

    async function login() {
      try {
        const data = await apiRequest("/api/auth/login", {
          method: "POST",
          body: {
            username: usernameInput.value.trim(),
            password: passwordInput.value
          }
        });

        setToken(data.token);
        setStatus("로그인되었습니다. 채팅 화면으로 이동합니다.", "success");
        window.location.replace("/chat.html");
      } catch (error) {
        setStatus(error.message, "error");
      }
    }

    loginBtn.addEventListener("click", login);
    passwordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        login();
      }
    });
    return;
  }

  if (page === "register") {
    const { setStatus } = setupStatusBar();
    const usernameInput = document.getElementById("registerUsername");
    const nicknameInput = document.getElementById("registerNickname");
    const passwordInput = document.getElementById("registerPassword");
    const registerBtn = document.getElementById("registerBtn");

    restoreUser().then((user) => {
      if (user) {
        window.location.replace("/chat.html");
      }
    });

    async function register() {
      try {
        const data = await apiRequest("/api/auth/register", {
          method: "POST",
          body: {
            username: usernameInput.value.trim(),
            nickname: nicknameInput.value.trim(),
            password: passwordInput.value
          }
        });

        setToken(data.token);
        setStatus("회원가입이 완료되었습니다. 채팅 화면으로 이동합니다.", "success");
        window.location.replace("/chat.html");
      } catch (error) {
        setStatus(error.message, "error");
      }
    }

    registerBtn.addEventListener("click", register);
    passwordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        register();
      }
    });
    return;
  }

  if (page !== "chat") {
    return;
  }

  const { setStatus } = setupStatusBar();
  const profileNickname = document.getElementById("profileNickname");
  const profileUsername = document.getElementById("profileUsername");
  const profileRoom = document.getElementById("profileRoom");
  const profileRole = document.getElementById("profileRole");
  const savedRooms = document.getElementById("savedRooms");
  const recentRooms = document.getElementById("recentRooms");
  const createRoomTitle = document.getElementById("createRoomTitle");
  const joinRoomCode = document.getElementById("joinRoomCode");
  const roomTitle = document.getElementById("roomTitle");
  const roomSubtitle = document.getElementById("roomSubtitle");
  const roomCodeBadge = document.getElementById("roomCodeBadge");
  const hostBadge = document.getElementById("hostBadge");
  const usersList = document.getElementById("usersList");
  const messageList = document.getElementById("messageList");
  const messageInput = document.getElementById("messageInput");
  const imageInput = document.getElementById("imageInput");
  const imagePreviewText = document.getElementById("imagePreviewText");

  let currentUser = null;
  let currentRoom = null;
  let socket = null;

  function renderUserProfile() {
    profileNickname.textContent = currentUser?.nickname || "-";
    profileUsername.textContent = currentUser?.username || "-";
    profileRoom.textContent = currentRoom ? `${currentRoom.title} (${currentRoom.code})` : "없음";
    profileRole.textContent = currentRoom?.isHost ? "방장" : "참가자";
  }

  function renderRoomHeader() {
    if (!currentRoom) {
      roomTitle.textContent = "방에 아직 입장하지 않았습니다.";
      roomSubtitle.textContent = "로그인 후 방을 만들거나, 방 코드로 참가해주세요.";
      roomCodeBadge.classList.add("hidden");
      hostBadge.classList.add("hidden");
    } else {
      roomTitle.textContent = currentRoom.title;
      roomSubtitle.textContent = `${currentUser.nickname} 님으로 접속 중입니다. 현재 방 코드는 ${currentRoom.code} 입니다.`;
      roomCodeBadge.textContent = `방 코드 ${currentRoom.code}`;
      roomCodeBadge.classList.remove("hidden");
      hostBadge.classList.toggle("hidden", !currentRoom.isHost);
    }

    renderUserProfile();
  }

  function renderSavedRooms(rooms) {
    renderRoomList(savedRooms, rooms, "아직 만든 방이 없습니다.");
  }

  function renderRecentRooms(rooms) {
    renderRoomList(recentRooms, rooms, "아직 들어간 방 기록이 없습니다.");
  }

  function renderRoomList(target, rooms, emptyText) {
    target.innerHTML = "";

    if (!rooms.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = emptyText;
      target.appendChild(li);
      return;
    }

    rooms.forEach((room) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="user-row-top">
          <strong>${room.title}</strong>
          <span class="badge">${room.code}</span>
        </div>
        <button type="button" class="secondary" data-room-code="${room.code}">이 방으로 입장</button>
      `;
      target.appendChild(li);
    });
  }

  function renderUsers(payload) {
    const users = payload?.users || [];
    usersList.innerHTML = "";

    if (!users.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "현재 접속자가 없습니다.";
      usersList.appendChild(li);
      return;
    }

    users.forEach((user) => {
      const li = document.createElement("li");
      const canKick = currentRoom?.isHost && user.socketId !== socket?.id;
      li.innerHTML = `
        <div class="user-row-top">
          <strong>${user.nickname}${user.socketId === socket?.id ? " (나)" : ""}</strong>
          ${user.isHost ? '<span class="badge">방장</span>' : ""}
        </div>
        ${canKick ? `<button type="button" class="danger" data-kick-socket="${user.socketId}">강퇴</button>` : ""}
      `;
      usersList.appendChild(li);
    });
  }

  function clearMessages(text = "채팅 메시지가 아직 없습니다.") {
    messageList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = text;
    messageList.appendChild(li);
  }

  function formatTime(dateText) {
    return new Date(dateText).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function escapeHtml(value) {
    return (value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function appendMessage(msg, system = false) {
    const emptyState = messageList.querySelector(".empty-state");
    if (emptyState) {
      emptyState.remove();
    }

    const li = document.createElement("li");
    const isSelf = !system && currentUser && msg.senderId && String(msg.senderId) === String(currentUser.id);
    li.className = `message-item${system ? " system-message" : ""}${isSelf ? " self-message" : ""}`;

    const name = system ? "시스템" : escapeHtml(msg.sender || "알 수 없음");
    const textBlock = msg.text ? `<div>${escapeHtml(msg.text).replace(/\n/g, "<br />")}</div>` : "";
    const imageBlock = msg.imageData ? `<img class="message-image" src="${msg.imageData}" alt="채팅 이미지" />` : "";

    li.innerHTML = `
      <div class="message-meta">
        <strong>${name}</strong>
        <span>${formatTime(msg.createdAt || new Date().toISOString())}</span>
      </div>
      ${textBlock}
      ${imageBlock}
    `;

    messageList.appendChild(li);
    messageList.scrollTop = messageList.scrollHeight;
  }

  function updateImagePreview() {
    const file = imageInput.files[0];
    imagePreviewText.textContent = file ? `선택한 사진: ${file.name}` : "사진은 선택 사항입니다.";
  }

  function resetComposer() {
    messageInput.value = "";
    imageInput.value = "";
    updateImagePreview();
    messageInput.focus();
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("이미지 파일을 읽을 수 없습니다."));
      reader.readAsDataURL(file);
    });
  }

  async function refreshMyRooms() {
    const data = await apiRequest("/api/rooms/mine");
    renderSavedRooms(data.rooms || []);
  }

  async function refreshRecentRooms() {
    const data = await apiRequest("/api/rooms/recent");
    renderRecentRooms(data.rooms || []);
  }

  function disconnectSocket() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  function connectSocket() {
    disconnectSocket();

    socket = io("/", {
      transports: ["websocket"],
      auth: {
        token: getToken()
      }
    });

    socket.on("session:user", (user) => {
      currentUser = user;
      renderUserProfile();
    });

    socket.on("room:state", (room) => {
      currentRoom = room;
      renderRoomHeader();
      if (room?.isHost) {
        refreshMyRooms().catch(() => {});
      }
      if (room) {
        refreshRecentRooms().catch(() => {});
      }
      if (!room) {
        clearMessages("현재 입장한 방이 없습니다.");
        renderUsers({ users: [] });
      }
    });

    socket.on("room:users", (payload) => {
      if (payload?.room && currentRoom && payload.room.code === currentRoom.code) {
        currentRoom = {
          ...currentRoom,
          hostUserId: payload.room.hostUserId,
          isHost: payload.room.hostUserId === currentUser?.id
        };
        renderRoomHeader();
      }

      renderUsers(payload);
    });

    socket.on("chat:history", (messages) => {
      if (!messages.length) {
        clearMessages(currentRoom ? "이 방에는 아직 메시지가 없습니다." : "현재 입장한 방이 없습니다.");
        return;
      }

      messageList.innerHTML = "";
      messages.forEach((message) => appendMessage(message));
    });

    socket.on("chat:receive", (message) => {
      appendMessage(message);
    });

    socket.on("system:notice", (message) => {
      appendMessage({
        sender: "시스템",
        text: message.text,
        createdAt: message.createdAt
      }, true);
    });

    socket.on("room:kicked", (payload) => {
      currentRoom = null;
      renderRoomHeader();
      clearMessages("방장에서 강퇴되어 현재 방을 나왔습니다.");
      renderUsers({ users: [] });
      setStatus(`${payload.byNickname} 님이 ${payload.roomCode} 방에서 강퇴했습니다.`, "error");
    });

    socket.on("chat:error", (message) => {
      setStatus(message, "error");
    });

    socket.on("connect_error", () => {
      setStatus("소켓 연결에 실패했습니다. 다시 로그인해주세요.", "error");
    });
  }

  async function initChatPage() {
    currentUser = await restoreUser();
    if (!currentUser) {
      window.location.replace("/login.html");
      return;
    }

    renderRoomHeader();
    clearMessages("방을 만들거나 참가하면 대화가 여기에 표시됩니다.");
    renderUsers({ users: [] });
    await refreshMyRooms();
    await refreshRecentRooms();
    connectSocket();
    setStatus(`${currentUser.nickname} 님으로 로그인되어 있습니다.`, "success");
  }

  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearToken();
    currentUser = null;
    currentRoom = null;
    disconnectSocket();
    window.location.replace("/");
  });

  document.getElementById("createRoomBtn").addEventListener("click", () => {
    if (!socket) {
      setStatus("로그인 후 다시 시도해주세요.", "error");
      return;
    }

    socket.emit("room:create", {
      title: createRoomTitle.value.trim()
    });
    setStatus("방을 생성하고 있습니다...");
    createRoomTitle.value = "";
  });

  document.getElementById("joinRoomBtn").addEventListener("click", () => {
    if (!socket) {
      setStatus("로그인 후 다시 시도해주세요.", "error");
      return;
    }

    const code = joinRoomCode.value.trim().toUpperCase();
    if (!code) {
      setStatus("입장할 방 코드를 입력해주세요.", "error");
      return;
    }

    socket.emit("room:join", { code });
    setStatus(`${code} 방으로 입장 중입니다...`);
    joinRoomCode.value = "";
  });

  document.getElementById("leaveRoomBtn").addEventListener("click", () => {
    if (!socket) {
      return;
    }

    socket.emit("room:leave");
    setStatus("현재 방에서 나왔습니다.", "success");
  });

  document.getElementById("sendBtn").addEventListener("click", async () => {
    if (!socket || !currentRoom) {
      setStatus("먼저 방에 입장해주세요.", "error");
      return;
    }

    try {
      const text = messageInput.value.trim();
      const file = imageInput.files[0];
      const imageData = file ? await fileToDataUrl(file) : "";

      if (!text && !imageData) {
        return;
      }

      socket.emit("chat:send", {
        text,
        imageData
      });

      resetComposer();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("clearImageBtn").addEventListener("click", () => {
    imageInput.value = "";
    updateImagePreview();
  });

  imageInput.addEventListener("change", updateImagePreview);

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      document.getElementById("sendBtn").click();
    }
  });

  savedRooms.addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-code]");
    if (!button || !socket) {
      return;
    }

    socket.emit("room:join", {
      code: button.dataset.roomCode
    });
    setStatus(`${button.dataset.roomCode} 방으로 입장 중입니다...`);
  });

  recentRooms.addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-code]");
    if (!button || !socket) {
      return;
    }

    socket.emit("room:join", {
      code: button.dataset.roomCode
    });
    setStatus(`${button.dataset.roomCode} 방으로 입장 중입니다...`);
  });

  usersList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kick-socket]");
    if (!button || !socket) {
      return;
    }

    socket.emit("room:kick", {
      targetSocketId: button.dataset.kickSocket
    });
  });

  clearMessages("방을 만들거나 참가하면 대화가 여기에 표시됩니다.");
  renderUsers({ users: [] });
  renderSavedRooms([]);
  renderRecentRooms([]);
  updateImagePreview();
  initChatPage();
}());
