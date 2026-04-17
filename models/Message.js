const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    sender: String,
    text: String,
    room: {
      type: String,
      default: "lobby",
      index: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
