import User from '../models/user-model.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { isAdminRole } from "../utils/roles.js";

// Register a new user
export const register = async (req, res) => {
  try {
    const { name, email, password, role, region } = req.body;
    
    // Check for required fields
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required fields: name, email, password, department"
      });
    }
    
    // Check if email is already registered
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Email is already registered"
      });
    }
    
    // Only admin can create admin users
    if (role === 'admin' && (!req.user || !isAdminRole(req.user.role))) {
      return res.status(403).json({
        success: false,
        message: "Only administrators can create admin users"
      });
    }
    
    // Create the user
    if (!role) {
      return res.status(400).json({
        success: false,
        message: "Please provide at least one role"
      });
    }
    if (!region) {
      return res.status(400).json({
        success: false,
        message: "Please provide at least one region"
      });
    }
    const user = await User.create({
      name,
      email,
      password,
      role: Array.isArray(role) ? role : [role],
     
      region: Array.isArray(region) ? region : [region]
    });
    
    // Generate token and return to client
    sendTokenResponse(user, 201, res, 'User registered successfully');
    
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to register user",
      error: error.message
    });
  }
};

// Login user
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Check for email and password
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide email and password"
      });
    }
    
    // Check for user
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Ensure role, department, and region are always arrays (defensive, in case of legacy data)
    const formattedUser = {
      ...user.toObject(),
      role: Array.isArray(user.role) ? user.role : [user.role],
      region: Array.isArray(user.region) ? user.region : [user.region]
    };
    // Check if password matches
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }
    
    // Update last login timestamp
    await user.updateLoginTimestamp();
    
    // Send token to client
    sendTokenResponse(user, 200, res, 'Login successful');
    
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to login",
      error: error.message
    });
  }
};

// Get current logged in user
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    res.status(200).json({
      success: true,
      data: user
    });
    
  } catch (error) {
    console.error('Get current user error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to get user information",
      error: error.message
    });
  }
};

// Update password
export const updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Please provide current and new password"
      });
    }
    
    const user = await User.findById(req.user.id).select('+password');
    
    // Check current password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect"
      });
    }
    
    user.password = newPassword;
    await user.save();
    
    sendTokenResponse(user, 200, res, 'Password updated successfully');
    
  } catch (error) {
    console.error('Update password error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to update password",
      error: error.message
    });
  }
};

// Admin: Get all users
export const getUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password');
    
    res.status(200).json({
      success: true,
      count: users.length,
      data: users
    });
    
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to get users",
      error: error.message
    });
  }
};

// Admin: Get single user
export const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }
    
    res.status(200).json({
      success: true,
      data: user
    });
    
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to get user",
      error: error.message
    });
  }
};

// Admin: Update user details
export const updateUser = async (req, res) => {
  try {
    const { name, email, role, region } = req.body;
    
    const fieldsToUpdate = {
      name,
      email,
      region
    };
    
    // Only allow admin to update role
    if (isAdminRole(req.user.role)) {
      fieldsToUpdate.role = role;
    }
    
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: fieldsToUpdate },
      { new: true, runValidators: true }
    );
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }
    
    res.status(200).json({
      success: true,
      data: user,
      message: "User updated successfully"
    });
    
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user",
      error: error.message
    });
  }
};

// Admin: Delete user
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }
    
    // Prevent deleting self
    if (user._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account"
      });
    }
    
    await user.deleteOne();
    
    res.status(200).json({
      success: true,
      message: "User deleted successfully"
    });
    
  } catch (error) {
    console.error('Delete user error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete user",
      error: error.message
    });
  }
};

// Helper function to get token from model, create cookie and send response
const sendTokenResponse = (user, statusCode, res, message) => {
  // Create token
  const token = user.getSignedToken();
  
  // Return response
  res.status(statusCode).json({
    success: true,
    message,
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      region: user.region
    }
  });
};

export default {
  register,
  login,
  getMe,
  updatePassword,
  getUsers,
  getUser,
  updateUser,
  deleteUser
};
