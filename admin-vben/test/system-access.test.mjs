import assert from "node:assert/strict";
import test from "node:test";
import routes from "../apps/web-ele/src/router/routes/modules/system.ts";
import {
  canAssignRole,
  filterUsers,
  grantablePermissions,
  loginIdentity,
  passwordError,
} from "../apps/web-ele/src/views/system/access-model.ts";

const roles = [
  {
    id: 1,
    code: "super_admin",
    name: "超级管理员",
    isSystem: true,
    permissionCodes: ["admins.manage", "roles.manage", "documents.read"],
  },
  {
    id: 2,
    code: "account_manager",
    name: "账号管理",
    isSystem: false,
    permissionCodes: ["admins.manage"],
  },
  {
    id: 3,
    code: "editor",
    name: "资料编辑",
    isSystem: false,
    permissionCodes: ["documents.read"],
  },
];

test("management routes are gated by their respective platform permissions", () => {
  assert.equal(routes.length, 2);
  assert.deepEqual(
    routes.find((route) => route.path === "/system/users").meta.authority,
    ["admins.manage"],
  );
  assert.deepEqual(
    routes.find((route) => route.path === "/system/roles").meta.authority,
    ["roles.manage"],
  );
});

test("platform role grants are independent from workspace effective permissions", () => {
  assert.deepEqual(
    [...grantablePermissions(roles, ["account_manager"])],
    ["admins.manage"],
  );
  assert.equal(canAssignRole(roles[0], roles, ["account_manager"]), false);
  assert.equal(canAssignRole(roles[1], roles, ["account_manager"]), true);
  assert.equal(canAssignRole(roles[2], roles, ["account_manager"]), false);
  assert.equal(canAssignRole(roles[0], roles, ["super_admin"]), true);
  assert.equal(canAssignRole(roles[2], roles, ["super_admin"]), true);
  assert.equal(canAssignRole(roles[1], roles, []), false);
});

test("account identity normalizes username or email without sending empty extra fields", () => {
  assert.deepEqual(loginIdentity(" Admin-User "), { username: "admin-user" });
  assert.deepEqual(loginIdentity(" Admin@Example.com "), {
    email: "admin@example.com",
  });
});

test("password validation respects backend character and bcrypt UTF-8 limits", () => {
  assert.ok(passwordError("short"));
  assert.equal(passwordError("secure-account-password"), "");
  assert.equal(passwordError("a".repeat(72)), "");
  assert.ok(passwordError("a".repeat(73)));
  assert.equal(passwordError("密".repeat(24)), "");
  assert.ok(passwordError("密".repeat(25)));
});

test("user filtering combines identity search and enabled status", () => {
  const users = [
    {
      id: 1,
      username: "admin-user",
      email: null,
      displayName: "管理员",
      disabledAt: null,
      roles: [],
    },
    {
      id: 2,
      username: null,
      email: "test@example.com",
      displayName: "测试用户",
      disabledAt: "2026-10-13",
      roles: [],
    },
  ];
  assert.deepEqual(
    filterUsers(users, " ADMIN ", "enabled").map((user) => user.id),
    [1],
  );
  assert.deepEqual(
    filterUsers(users, "example.com", "disabled").map((user) => user.id),
    [2],
  );
  assert.deepEqual(filterUsers(users, "测试", "enabled"), []);
  assert.deepEqual(
    filterUsers(users, "2", "").map((user) => user.id),
    [2],
  );
  assert.equal(filterUsers(users, "", "").length, 2);
});
