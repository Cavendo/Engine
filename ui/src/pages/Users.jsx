import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, KeyRound, Bot, Shield, ShieldCheck, Eye } from 'lucide-react';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge } from '../components/Badge';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { Input, Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';

const ROLE_CONFIG = {
  admin: { variant: 'purple', label: 'Admin', icon: ShieldCheck },
  reviewer: { variant: 'blue', label: 'Reviewer', icon: Shield },
  viewer: { variant: 'gray', label: 'Viewer', icon: Eye }
};

export default function Users() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [resetPasswordUser, setResetPasswordUser] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => { loadUsers(); }, []);

  const loadUsers = async () => {
    try {
      const data = await api.users.list();
      setUsers(data);
    } catch (err) {
      if (err.status === 403) {
        setAccessDenied(true);
      } else {
        console.error('Failed to load users:', err);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (user) => {
    try {
      await api.users.delete(user.id);
      setDeleteConfirm(null);
      loadUsers();
    } catch (err) {
      console.error('Failed to delete user:', err);
    }
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <Card>
          <CardBody>
            <div className="text-center py-12">
              <p className="text-gray-500">You need admin access to manage users.</p>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage team members. Each user automatically gets a linked agent for task assignment.
          </p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Add User
        </Button>
      </div>

      {users.length === 0 ? (
        <Card>
          <CardBody>
            <div className="text-center py-12">
              <p className="text-gray-500">No users yet. Add your first team member to get started.</p>
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              onEdit={() => setEditingUser(user)}
              onResetPassword={() => setResetPasswordUser(user)}
              onDelete={() => setDeleteConfirm(user)}
            />
          ))}
        </div>
      )}

      <CreateUserModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={() => { setShowCreateModal(false); loadUsers(); }}
      />

      {editingUser && (
        <EditUserModal
          isOpen={!!editingUser}
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSubmit={() => { setEditingUser(null); loadUsers(); }}
        />
      )}

      {resetPasswordUser && (
        <ResetPasswordModal
          isOpen={!!resetPasswordUser}
          user={resetPasswordUser}
          onClose={() => setResetPasswordUser(null)}
        />
      )}

      {deleteConfirm && (
        <Modal isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Delete User">
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Are you sure you want to delete <strong>{deleteConfirm.name || deleteConfirm.email}</strong>?
              This will also remove their linked agent and any API keys. Tasks previously assigned to them will remain but become unassigned.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => handleDelete(deleteConfirm)}>Delete User</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UserRow({ user, onEdit, onResetPassword, onDelete }) {
  const roleConfig = ROLE_CONFIG[user.role] || ROLE_CONFIG.viewer;

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center text-sm font-medium text-gray-600">
              {(user.name || user.email).charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{user.name || user.email.split('@')[0]}</span>
                <StatusBadge status={user.status} />
                <Badge variant={roleConfig.variant}>{roleConfig.label}</Badge>
              </div>
              <div className="text-sm text-gray-500 mt-0.5">{user.email}</div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Linked agent indicator */}
            {user.linked_agent_id && (
              <div className="flex items-center gap-1.5 text-xs text-gray-400" title={`Linked agent: ${user.linked_agent_name} (ID ${user.linked_agent_id})`}>
                <Bot className="w-3.5 h-3.5" />
                <span>Agent #{user.linked_agent_id}</span>
              </div>
            )}

            {/* Last login */}
            {user.last_login_at && (
              <span className="text-xs text-gray-400">
                Last login {safeTimeAgo(user.last_login_at)}
              </span>
            )}

            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={onResetPassword} title="Reset password">
                <KeyRound className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={onEdit} title="Edit user">
                <Pencil className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={onDelete} title="Delete user">
                <Trash2 className="w-4 h-4 text-red-500" />
              </Button>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function CreateUserModal({ isOpen, onClose, onSubmit }) {
  const [formData, setFormData] = useState({ name: '', email: '', password: '', role: 'reviewer' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const resetForm = () => {
    setFormData({ name: '', email: '', password: '', role: 'reviewer' });
    setError(null);
  };

  const handleClose = () => { resetForm(); onClose(); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.users.create(formData);
      resetForm();
      onSubmit();
    } catch (err) {
      setError(err.message || 'Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add User">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <Input label="Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="e.g. Sarah Chen" />
        <Input label="Email" type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          placeholder="sarah@company.com" required />
        <Input label="Password" type="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })}
          placeholder="Minimum 8 characters" required />
        <Select label="Role" value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value })}
          options={[
            { value: 'admin', label: 'Admin - Full access, can manage users and settings' },
            { value: 'reviewer', label: 'Reviewer - Can review deliverables and manage tasks' },
            { value: 'viewer', label: 'Viewer - Read-only access' }
          ]}
        />

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-sm text-blue-700">
            A linked agent will be created automatically so this user can be assigned tasks.
            They can also generate an MCP key from their profile to use AI tools with Cavendo.
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add User</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserModal({ isOpen, user, onClose, onSubmit }) {
  const [formData, setFormData] = useState({
    name: user.name || '',
    email: user.email,
    role: user.role,
    status: user.status
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.users.update(user.id, formData);
      onSubmit();
    } catch (err) {
      setError(err.message || 'Failed to update user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Edit User — ${user.name || user.email}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <Input label="Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="e.g. Sarah Chen" />
        <Input label="Email" type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          required />
        <Select label="Role" value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value })}
          options={[
            { value: 'admin', label: 'Admin' },
            { value: 'reviewer', label: 'Reviewer' },
            { value: 'viewer', label: 'Viewer' }
          ]}
        />
        <Select label="Status" value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive - Disables login and linked agent' }
          ]}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save Changes</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ isOpen, user, onClose }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.users.resetPassword(user.id, password);
      setSuccess(true);
      setPassword('');
    } catch (err) {
      setError(err.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setPassword('');
    setError(null);
    setSuccess(false);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Reset Password — ${user.name || user.email}`}>
      {success ? (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-sm text-green-700">Password reset successfully. All existing sessions have been invalidated.</p>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
          <Input label="New Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Minimum 8 characters" required />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={handleClose}>Cancel</Button>
            <Button type="submit" loading={loading}>Reset Password</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
