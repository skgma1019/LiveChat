const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    nickname: {
      type: String,
      required: true,
      trim: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    passwordSalt: {
      type: String,
      required: true
    },
    recentRooms: {
      type: [
        {
          code: {
            type: String,
            required: true
          },
          title: {
            type: String,
            required: true
          },
          joinedAt: {
            type: Date,
            default: Date.now
          }
        }
      ],
      default: []
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
