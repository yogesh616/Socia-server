import express from "express";
import User from "../models/User.js";
import jwt from "jsonwebtoken";
import protectRoute from "../middleware/auth.middleware.js";
import cloudinary from "../lib/cloudinary.js";
const router = express.Router();

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "15d" });
};

router.post("/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    console.log(email)

    if (!username || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password should be at least 6 characters long" });
    }

    if (username.length < 3) {
      return res.status(400).json({ message: "Username should be at least 3 characters long" });
    }

    // check if user already exists
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ message: "Username already exists" });
    }

    // get random avatar
    const profileImage = `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;

    const user = new User({
      email,
      username,
      password,
      profileImage,
    });

    await user.save();

    const token = generateToken(user._id);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        profileImage: user.profileImage,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.log("Error in register route", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) return res.status(400).json({ message: "All fields are required" });

    // check if user exists
    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    // check if password is correct
    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) return res.status(400).json({ message: "Invalid credentials" });

    const token = generateToken(user._id);

    res.status(200).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        profileImage: user.profileImage,
        createdAt: user.createdAt,
        fullName: user.fullName,
        bio: user.bio,
        website: user.website,
        location: user.location,
        followers: user.followers,
        following: user.following,
      },
    });
  } catch (error) {
    console.log("Error in login route", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route to update profileImage
router.post("/profileImage", protectRoute, async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) return res.status(400).json({ message: "Please provide an image" });

    // Upload image to Cloudinary
    const uploadResponse = await cloudinary.uploader.upload(image);
    const imageUrl = uploadResponse.secure_url;

    // Update user's profileImage
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { profileImage: imageUrl },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({
      message: "Profile image updated successfully",
      profileImage: user.profileImage,
    });
  } catch (error) {
    console.log("Error updating profile image", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


router.get("/users", protectRoute, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user._id } }).select("_id username email profileImage ");
    res.status(200).json({ users });
  } catch (error) {
    console.log("Error fetching users", error);
    res.status(500).json({ message: "Internal server error" });
  } 
});

// Route to update user profile
router.put("/update-profile", protectRoute, async (req, res) => {
  try {
    const { username, fullName, bio, website, location } = req.body;

    const updates = {};

    // Validate username
    if (username && username.length < 3) {
      return res.status(400).json({ message: "Username should be at least 3 characters long" });
    }
    if (username) {
      const existingUsername = await User.findOne({ username, _id: { $ne: req.user._id } });
      if (existingUsername) {
        return res.status(400).json({ message: "Username already exists" });
      }
      updates.username = username.trim();
    }

    // Optional updates
    if (fullName) updates.fullName = fullName.trim();
    if (bio) updates.bio = bio.trim();
    if (website) updates.website = website.trim();
    if (location) updates.location = location.trim();

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true }
    ).select("username email profileImage fullName bio website location createdAt");

    if (!updatedUser) return res.status(404).json({ message: "User not found" });

    res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.log("Error updating profile", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Route to get user by ID
router.get("/user/:id", protectRoute, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "username email profileImage fullName bio website location followers following createdAt"
    );
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ user });
  } catch (error) {
    console.log("Error fetching user", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
