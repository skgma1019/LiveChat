require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const Message = require("./models/Message");
const Room = require("./models/Room");
const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = 3000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || "livechat-dev-secret";
const IMAGE_SIZE_LIMIT = 2 * 1024 * 1024;
const VIDEO_SIZE_LIMIT = 10 * 1024 * 1024;
const MESSAGE_MAX_LENGTH = 5000;
const activeUsers = new Map();
const uploadsDir = path.join(__dirname, "public", "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname) || "";
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`);
    }
  }),
  limits: {
    fileSize: VIDEO_SIZE_LIMIT
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image and video uploads are allowed."));
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passwordHash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { salt, passwordHash };
}

function verifyPassword(password, salt, passwordHash) {
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(passwordHash, "hex"));
}

function encodeBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function createAuthToken(user) {
  const payload = JSON.stringify({
    userId: String(user._id),
    issuedAt: Date.now()
  });
  const payloadPart = encodeBase64Url(payload);
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(payloadPart)
    .digest("hex");

  return `${payloadPart}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  const [payloadPart, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(payloadPart)
    .digest("hex");

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    return JSON.parse(decodeBase64Url(payloadPart));
  } catch (error) {
    return null;
  }
}

function sanitizeUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    nickname: user.nickname
  };
}

async function rememberRecentRoom(userId, room) {
  const user = await User.findById(userId);
  if (!user) {
    return;
  }

  const roomCode = String(room.code).toUpperCase();
  const filteredRooms = (user.recentRooms || []).filter((item) => item.code !== roomCode);
  filteredRooms.unshift({
    code: roomCode,
    title: room.title,
    joinedAt: new Date()
  });
  user.recentRooms = filteredRooms.slice(0, 10);
  await user.save();
}

function buildRoomUserList(roomCode) {
  return Array.from(activeUsers.entries())
    .filter(([, user]) => user.roomCode === roomCode)
    .map(([socketId, user]) => ({
      socketId,
      userId: user.userId,
      nickname: user.nickname,
      isHost: user.isHost
    }));
}

async function emitRoomUsers(roomCode) {
  const room = await Room.findOne({ code: roomCode }).lean();
  io.to(roomCode).emit("room:users", {
    room: room
      ? {
          code: room.code,
          title: room.title,
          hostUserId: String(room.hostUserId)
        }
      : null,
    users: buildRoomUserList(roomCode)
  });
}

function createRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

async function generateUniqueRoomCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = createRoomCode();
    const exists = await Room.exists({ code });
    if (!exists) {
      return code;
    }
  }

  throw new Error("Failed to generate a unique room code.");
}

async function buildRoomState(roomCode, userId) {
  const room = await Room.findOne({ code: roomCode }).lean();

  if (!room) {
    return null;
  }

  return {
    code: room.code,
    title: room.title,
    hostUserId: String(room.hostUserId),
    isHost: String(room.hostUserId) === String(userId)
  };
}

async function emitRoomState(socket, roomCode) {
  const user = activeUsers.get(socket.id);
  if (!user || !roomCode) {
    socket.emit("room:state", null);
    return;
  }

  const roomState = await buildRoomState(roomCode, user.userId);
  socket.emit("room:state", roomState);
}

async function leaveCurrentRoom(socket) {
  const activeUser = activeUsers.get(socket.id);
  if (!activeUser?.roomCode) {
    return;
  }

  const previousRoomCode = activeUser.roomCode;
  socket.leave(previousRoomCode);
  activeUsers.set(socket.id, {
    ...activeUser,
    roomCode: null,
    roomTitle: null,
    isHost: false
  });

  socket.emit("room:state", null);
  socket.emit("chat:history", {
    roomCode: previousRoomCode,
    messages: []
  });
  await emitRoomUsers(previousRoomCode);
}

async function joinRoom(socket, room) {
  const activeUser = activeUsers.get(socket.id);
  if (!activeUser) {
    throw new Error("Unauthorized socket.");
  }

  if (activeUser.roomCode && activeUser.roomCode !== room.code) {
    await leaveCurrentRoom(socket);
  }

  socket.join(room.code);
  const isHost = String(room.hostUserId) === activeUser.userId;

  activeUsers.set(socket.id, {
    ...activeUser,
    roomCode: room.code,
    roomTitle: room.title,
    isHost
  });

  const history = await Message.find({ roomCode: room.code })
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  await rememberRecentRoom(activeUser.userId, room);
  await emitRoomState(socket, room.code);
  socket.emit("chat:history", {
    roomCode: room.code,
    messages: history
  });
  await emitRoomUsers(room.code);
}

async function requireHttpUser(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = verifyAuthToken(token);

  if (!payload?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await User.findById(payload.userId);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.user = user;
  next();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = req.body?.username?.trim();
    const nickname = req.body?.nickname?.trim();
    const password = req.body?.password;

    if (!username || !nickname || !password) {
      res.status(400).json({ error: "아이디, 닉네임, 비밀번호를 모두 입력해주세요." });
      return;
    }

    if (password.length < 4) {
      res.status(400).json({ error: "비밀번호는 4자 이상이어야 합니다." });
      return;
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
      return;
    }

    const { salt, passwordHash } = hashPassword(password);
    const user = await User.create({
      username,
      nickname,
      passwordHash,
      passwordSalt: salt
    });

    const token = createAuthToken(user);
    res.status(201).json({
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "회원가입 중 오류가 발생했습니다." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = req.body?.username?.trim();
    const password = req.body?.password;

    const user = await User.findOne({ username });
    if (!user || !verifyPassword(password || "", user.passwordSalt, user.passwordHash)) {
      res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      return;
    }

    const token = createAuthToken(user);
    res.json({
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "로그인 중 오류가 발생했습니다." });
  }
});

app.get("/api/auth/me", requireHttpUser, async (req, res) => {
  res.json({
    user: sanitizeUser(req.user)
  });
});

app.get("/api/rooms/mine", requireHttpUser, async (req, res) => {
  const rooms = await Room.find({ hostUserId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  res.json({
    rooms: rooms.map((room) => ({
      code: room.code,
      title: room.title,
      hostUserId: String(room.hostUserId)
    }))
  });
});

app.get("/api/rooms/recent", requireHttpUser, async (req, res) => {
  const recentRooms = (req.user.recentRooms || [])
    .slice()
    .sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt))
    .map((room) => ({
      code: room.code,
      title: room.title,
      joinedAt: room.joinedAt
    }));

  res.json({
    rooms: recentRooms
  });
});

app.post("/api/uploads", requireHttpUser, (req, res) => {
  upload.single("media")(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: "파일 크기가 제한을 초과했습니다. 사진 2MB, 동영상 10MB 이하로 시도해주세요." });
        return;
      }

      res.status(400).json({ error: "업로드할 수 없는 파일입니다." });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "업로드할 파일을 선택해주세요." });
      return;
    }

    const isImage = file.mimetype.startsWith("image/");
    if (isImage && file.size > IMAGE_SIZE_LIMIT) {
      fs.unlink(file.path, () => {});
      res.status(400).json({ error: "이미지 크기가 너무 큽니다. 2MB 이하로 시도해주세요." });
      return;
    }

    res.status(201).json({
      mediaUrl: `/uploads/${file.filename}`,
      mediaMime: file.mimetype,
      mediaType: isImage ? "image" : "video",
      originalName: file.originalname
    });
  });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = verifyAuthToken(token);

    if (!payload?.userId) {
      next(new Error("Unauthorized"));
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      next(new Error("Unauthorized"));
      return;
    }

    socket.user = sanitizeUser(user);
    next();
  } catch (error) {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  activeUsers.set(socket.id, {
    userId: socket.user.id,
    nickname: socket.user.nickname,
    roomCode: null,
    roomTitle: null,
    isHost: false
  });

  socket.emit("session:user", socket.user);

  socket.on("room:create", async ({ title }) => {
    try {
      const trimmedTitle = title?.trim() || `${socket.user.nickname}의 방`;
      const code = await generateUniqueRoomCode();
      const room = await Room.create({
        code,
        title: trimmedTitle,
        hostUserId: socket.user.id
      });

      await joinRoom(socket, room);
    } catch (error) {
      console.error("Create room error:", error);
      socket.emit("chat:error", "방 생성 중 오류가 발생했습니다.");
    }
  });

  socket.on("room:join", async ({ code }) => {
    try {
      const roomCode = code?.trim()?.toUpperCase();
      if (!roomCode) {
        socket.emit("chat:error", "방 코드를 입력해주세요.");
        return;
      }

      const room = await Room.findOne({ code: roomCode });
      if (!room) {
        socket.emit("chat:error", "존재하지 않는 방 코드입니다.");
        return;
      }

      await joinRoom(socket, room);
    } catch (error) {
      console.error("Join room error:", error);
      socket.emit("chat:error", "방 입장 중 오류가 발생했습니다.");
    }
  });

  socket.on("room:leave", async () => {
    try {
      await leaveCurrentRoom(socket);
    } catch (error) {
      console.error("Leave room error:", error);
      socket.emit("chat:error", "방 나가기 중 오류가 발생했습니다.");
    }
  });

  socket.on("room:kick", async ({ targetSocketId }) => {
    try {
      const activeUser = activeUsers.get(socket.id);
      const targetUser = activeUsers.get(targetSocketId);

      if (!activeUser?.roomCode || !targetUser?.roomCode || activeUser.roomCode !== targetUser.roomCode) {
        socket.emit("chat:error", "강퇴할 사용자를 찾을 수 없습니다.");
        return;
      }

      const room = await Room.findOne({ code: activeUser.roomCode });
      if (!room || String(room.hostUserId) !== activeUser.userId) {
        socket.emit("chat:error", "방장만 강퇴할 수 있습니다.");
        return;
      }

      if (targetSocketId === socket.id) {
        socket.emit("chat:error", "방장은 자기 자신을 강퇴할 수 없습니다.");
        return;
      }

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (!targetSocket) {
        socket.emit("chat:error", "대상 사용자가 이미 접속 종료되었습니다.");
        return;
      }

      const kickedNickname = targetUser.nickname;
      await leaveCurrentRoom(targetSocket);
      targetSocket.emit("room:kicked", {
        roomCode: room.code,
        byNickname: socket.user.nickname
      });

      io.to(room.code).emit("system:notice", {
        text: `${kickedNickname} 님이 방에서 강퇴되었습니다.`,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("Kick user error:", error);
      socket.emit("chat:error", "강퇴 중 오류가 발생했습니다.");
    }
  });

  socket.on("chat:send", async (msg) => {
    try {
      const activeUser = activeUsers.get(socket.id);
      if (!activeUser?.roomCode) {
        socket.emit("chat:error", "먼저 방에 참가해주세요.");
        return;
      }

      const text = msg?.text?.trim() || "";
      const mediaUrl = msg?.mediaUrl || "";
      const mediaMime = msg?.mediaMime || "";
      const hasImage = typeof mediaUrl === "string" && mediaUrl.startsWith("/uploads/") && mediaMime.startsWith("image/");
      const hasVideo = typeof mediaUrl === "string" && mediaUrl.startsWith("/uploads/") && mediaMime.startsWith("video/");

      if (!text && !hasImage && !hasVideo) {
        return;
      }

      if (text.length > MESSAGE_MAX_LENGTH) {
        socket.emit("chat:error", `메시지는 ${MESSAGE_MAX_LENGTH}자 이하로만 보낼 수 있습니다.`);
        return;
      }

      if (hasImage && hasVideo) {
        socket.emit("chat:error", "한 번에 사진 또는 동영상 하나만 보낼 수 있습니다.");
        return;
      }

      const messageType = hasVideo ? "video" : hasImage ? "image" : "text";

      const saved = await Message.create({
        sender: activeUser.nickname,
        senderId: activeUser.userId,
        roomCode: activeUser.roomCode,
        type: messageType,
        text,
        mediaUrl: hasImage || hasVideo ? mediaUrl : "",
        mediaMime: hasImage || hasVideo ? mediaMime : "",
        imageData: "",
        videoData: ""
      });

      io.to(activeUser.roomCode).emit("chat:receive", saved);
    } catch (error) {
      console.error("Save message error:", error);
      socket.emit("chat:error", "메시지 저장 중 오류가 발생했습니다.");
    }
  });

  socket.on("disconnect", async () => {
    try {
      const activeUser = activeUsers.get(socket.id);
      activeUsers.delete(socket.id);

      if (activeUser?.roomCode) {
        await emitRoomUsers(activeUser.roomCode);
      }
    } catch (error) {
      console.error("Disconnect error:", error);
    }
  });
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB connection error:", err));

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
