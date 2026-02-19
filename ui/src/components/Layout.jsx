import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import cavendoMark from '../assets/cavendo-mark.png';
import {
  Bot,
  ClipboardList,
  FileCheck,
  Folder,
  BookOpen,
  Webhook,
  Activity,
  LogOut,
  Settings,
  Package,
  Route,
  Users
} from 'lucide-react';

const navigation = [
  { name: 'Review', href: '/review', icon: FileCheck },
  { name: 'Tasks', href: '/tasks', icon: ClipboardList },
  { name: 'Deliverables', href: '/deliverables', icon: Package },
  { name: 'Projects', href: '/projects', icon: Folder },
  { name: 'Knowledge', href: '/knowledge', icon: BookOpen },
  { name: 'Routes', href: '/routes', icon: Route },
  { name: 'Webhooks', href: '/webhooks', icon: Webhook },
  { name: 'Activity', href: '/activity', icon: Activity },
  { name: 'Users', href: '/users', icon: Users, adminOnly: true },
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'Agents', href: '/agents', icon: Bot, adminOnly: true },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  const visibleNav = navigation.filter(item => {
    if (item.adminOnly && user?.role !== 'admin') return false;
    return true;
  });

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <div className="w-64 bg-gray-900 text-white flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-gray-800">
          <Link to="/" className="flex items-center gap-2">
            <img src={cavendoMark} alt="Cavendo" className="w-8 h-8" />
            <span className="font-semibold">Cavendo Engine</span>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1">
          {visibleNav.map((item) => {
            const isActive = location.pathname.startsWith(item.href);
            return (
              <Link
                key={item.name}
                to={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* User menu */}
        <div className="p-4 border-t border-gray-800">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-sm">
              {user?.name?.charAt(0) || user?.email?.charAt(0) || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user?.name || user?.email}</div>
              <div className="text-xs text-gray-500 truncate">{user?.role}</div>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
