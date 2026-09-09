import jwt from 'jsonwebtoken';
import User from '../models/user-model.js';
import Bill from '../models/bill-model.js';
import { asRoles, hasAnyRole, isAdminRole, primaryRole, describeRoles } from '../utils/roles.js';

// Role to state permission mapping

//basic jwt middleware
export const authMiddleware = (req, res, next) => {
  try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) return res.status(401).json({ message: "No token provided" });
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
  } catch (error) {
      res.status(401).json({ message: "Unauthorized access" });
  }
};

// Admin-only middleware
export const isAdmin = (req, res, next) => {
  if (req.user && isAdminRole(req.user.role)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Admin access required' });
};

const statePermissions = {
  // Map of states and which roles can take action on them
  "Site_Officer": ["site_officer", "admin"],
  "Site_PIMO": ["site_pimo", "admin"],
  "QS_Site": ["qs_site", "admin"],
  "PIMO_Mumbai": ["pimo_mumbai", "admin"],
  "Directors": ["director", "admin"],
  "Accounts": ["accounts", "admin"],
  "Completed": ["admin"],
  "Rejected": ["admin"]
};

// Map roles to permissions for advancing from one state to the next
const advancePermissions = {
  "site_officer": ["Site_Officer"],
  "site_pimo": ["Site_PIMO"],
  "qs_site": ["QS_Site"],
  "pimo_mumbai": ["PIMO_Mumbai"],
  "director": ["Directors"],
  "accounts": ["Accounts"],
  "admin": ["Site_Officer", "Site_PIMO", "QS_Site", "PIMO_Mumbai", "Directors", "Accounts"]
};

// Map roles to permissions for reverting from one state to previous
const revertPermissions = {
  "site_officer": [],
  "site_pimo": ["QS_Site"],
  "qs_site": ["PIMO_Mumbai"],
  "pimo_mumbai": ["Directors"],
  "director": ["Accounts"],
  "accounts": ["Completed"],
  "admin": ["Site_PIMO", "QS_Site", "PIMO_Mumbai", "Directors", "Accounts", "Completed"]
};

// Authentication middleware
export const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Role-based authorization middleware
export const authorize = (...roleArgs) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    // Handle both array of roles and individual role arguments
    let roles = roleArgs;
    if (roleArgs.length === 1 && Array.isArray(roleArgs[0])) {
      roles = roleArgs[0];
    }

    // req.user.role is an ARRAY (see utils/roles.js). Comparing it as a scalar
    // rejected every user on every route this guards.
    if (!hasAnyRole(req.user.role, roles) && !isAdminRole(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User with role '${describeRoles(req.user.role)}' not authorized for this action`
      });
    }

    next();
  };
};

// Workflow validation middleware
export const validateWorkflowTransition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const action = req.path.split('/').pop(); // Get the action from URL (advance, revert, reject, recover)
    const bill = await Bill.findById(id);
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }
    const userRole = primaryRole(req.user.role);
    // Map roles to workflow steps (currentCount)
    const roleStepMap = {
      site_officer: 1,
      quality_inspector: 1,
      quantity_surveyor: 1,
      site_architect: 1,
      site_incharge: 1,
      site_engineer: 1,
      site_pimo: 1,
      pimo_mumbai: 2,
      qs_mumbai: 3,
      trustees: 5,
      accounts_department: 7,
      admin: 99 // admin can do anything
    };
    const currentCount = bill.currentCount;
    const userStep = roleStepMap[userRole];
    if (userStep === undefined) {
      return res.status(403).json({ success: false, message: `Role '${userRole}' is not allowed to perform workflow transitions.` });
    }
    // Admin bypass
    if (isAdminRole(req.user.role)) return next();
    // Forward: user can only forward if their step matches currentCount
    if (action === 'forward' && currentCount !== userStep) {
      return res.status(403).json({ success: false, message: `User with role '${userRole}' cannot forward bill at step ${currentCount}` });
    }
    // Backward: user can only revert if their step is one above currentCount
    if (action === 'backward' && currentCount !== userStep + 1) {
      return res.status(403).json({ success: false, message: `User with role '${userRole}' cannot revert bill at step ${currentCount}` });
    }
    // Allow reject/recover for all roles at their step
    next();
  } catch (error) {
    console.error('Workflow validation error:', error);
    res.status(500).json({ success: false, message: 'Error validating workflow transition', error: error.message });
  }
};

// Validate state access middleware
export const validateStateAccess = (req, res, next) => {
  const { state } = req.params;
  const userRole = primaryRole(req.user.role);
  
  // Define which roles can see which states
  const stateAccessMap = {
    'site_officer': ['Site_Officer'],
    'site_pimo': ['Site_Officer', 'Site_PIMO'],
    'qs_site': ['Site_PIMO', 'QS_Site'],
    'pimo_mumbai': ['QS_Site', 'PIMO_Mumbai'],
    'director': ['PIMO_Mumbai', 'Directors'],
    'accounts': ['Directors', 'Accounts', 'Completed'],
    'admin': ['Site_Officer', 'Site_PIMO', 'QS_Site', 'PIMO_Mumbai', 'Directors', 'Accounts', 'Completed', 'Rejected']
  };
  
  // Admin can access all states
  if (isAdminRole(req.user.role)) {
    return next();
  }
  
  // Check if the user can access the requested state
  if (!stateAccessMap[userRole]?.includes(state)) {
    return res.status(403).json({
      success: false,
      message: `User with role '${userRole}' cannot access bills in state '${state}'`
    });
  }
  
  next();
};

// Validate field access based on team
import { teamFieldAccessControl, roleToTeamMap } from '../constants/teamFieldAccess.js';

export const validateTeamFieldAccess = (req, res, next) => {
  try {
    const userRole = primaryRole(req.user.role);

    // Admin can update any field
    if (isAdminRole(req.user.role)) {
      return next();
    }
    
    // Get the team for this user's role
    const team = roleToTeamMap[userRole];
    if (!team) {
      return res.status(403).json({
        success: false,
        message: `User with role '${userRole}' is not assigned to any team with field update permissions`
      });
    }
    
    // Get allowed fields for this team
    const allowedFields = teamFieldAccessControl[team];
    if (!allowedFields) {
      return res.status(403).json({
        success: false,
        message: `No allowed fields defined for team ${team}`
      });
    }
    
    // Check if the request body has any fields that are not allowed for this team
    const requestBodyFields = Object.keys(req.body);
    
    // Flattened list of all field paths in the request body
    const flattenedRequestFields = [];
    
    // Recursively collect all field paths in the request body
    const collectFields = (obj, prefix = '') => {
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const fieldPath = prefix ? `${prefix}.${key}` : key;
          
          if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            collectFields(obj[key], fieldPath);
          } else {
            flattenedRequestFields.push(fieldPath);
          }
        }
      }
    };
    
    collectFields(req.body);
    
    // Check if any requested field is not allowed
    const unauthorizedFields = flattenedRequestFields.filter(field => !allowedFields.includes(field));
    
    if (unauthorizedFields.length > 0) {
      return res.status(403).json({
        success: false,
        message: `User with role '${userRole}' cannot update the following fields: ${unauthorizedFields.join(', ')}`,
        allowedFields
      });
    }
    
    next();
  } catch (error) {
    console.error('Field access validation error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error validating field access', 
      error: error.message 
    });
  }
};