const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: String,
      required: true
    },
    senderId: {
      type: String,
      default: ""
    },
    roomCode: {
      type: String,
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ["text", "image", "video"],
      default: "text"
    },
    text: {
      type: String,
      default: ""
    },
    imageData: {
      type: String,
      default: ""
    },
    videoData: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
