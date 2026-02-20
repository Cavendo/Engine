import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for existing session
    api.auth.me()
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const data = await api.auth.login(email, password);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
  };

  const refreshUser = async () => {
    const data = await api.auth.me();
    setUser(data.user);
    return data.user;
  };

  // Immediate auth state update (e.g., from change-password response)
  // without requiring a /auth/me round-trip
  const setAuthUser = (userData) => {
    setUser(userData);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, setAuthUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
