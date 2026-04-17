require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const Message = require("./models/Message");

const DEFAULT_ROOM = "lobby";
const activeUsers = new Map();

function buildRoomUserList(room) {
  return Array.from(activeUsers.entries())
    .filter(([, user]) => user.room === room)
    .map(([socketId, user]) => ({
      socketId,
      nickname: user.nickname
    }));
}

function emitRoomUsers(room) {
  io.to(room).emit("room:users", buildRoomUserList(room));
}

async function joinRoom(socket, nickname, roomName) {
  const nextRoom = roomName?.trim() || DEFAULT_ROOM;
  const nextNickname = nickname?.trim() || `Guest-${socket.id.slice(0, 5)}`;
  const previousUser = activeUsers.get(socket.id);
  const previousRoom = previousUser?.room;

  if (previousRoom && previousRoom !== nextRoom) {
    socket.leave(previousRoom);
  }

  socket.join(nextRoom);
  activeUsers.set(socket.id, {
    nickname: nextNickname,
    room: nextRoom
  });

  socket.emit("user:profile", {
    socketId: socket.id,
    nickname: nextNickname,
    room: nextRoom
  });

  const history = await Message.find({ room: nextRoom })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  socket.emit("chat:history", history);

  if (previousRoom && previousRoom !== nextRoom) {
    emitRoomUsers(previousRoom);
  }
  emitRoomUsers(nextRoom);
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB connection error:", err));

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "test.html"));
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("user:join", async ({ nickname, room }) => {
    try {
      await joinRoom(socket, nickname, room);
    } catch (error) {
      console.error("Join room error:", error);
      socket.emit("chat:error", "방 입장 중 오류가 발생했습니다.");
    }
  });

  socket.on("chat:send", async (msg) => {
    const user = activeUsers.get(socket.id);

    if (!user) {
      socket.emit("chat:error", "먼저 닉네임과 채팅방을 설정해주세요.");
      return;
    }

    const text = msg?.text?.trim();
    if (!text) {
      return;
    }

    try {
      const saved = await Message.create({
        sender: user.nickname,
        text,
        room: user.room
      });

      io.to(user.room).emit("chat:receive", saved);
    } catch (error) {
      console.error("Save message error:", error);
      socket.emit("chat:error", "메시지 저장 중 오류가 발생했습니다.");
    }
  });

  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    activeUsers.delete(socket.id);

    if (user?.room) {
      emitRoomUsers(user.room);
    }

    console.log("User disconnected:", socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
