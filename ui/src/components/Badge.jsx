const variants = {
  gray: 'bg-gray-100 text-gray-800',
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-purple-100 text-purple-800',
};

export default function Badge({ children, variant = 'gray', className = '' }) {
  return (
    <span
      className={`
        inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
        ${variants[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}

// Status-specific badges
export function StatusBadge({ status }) {
  const statusConfig = {
    active: { variant: 'green', label: 'Active' },
    inactive: { variant: 'gray', label: 'Inactive' },
    suspended: { variant: 'red', label: 'Suspended' },
    pending: { variant: 'yellow', label: 'Pending' },
    assigned: { variant: 'blue', label: 'Assigned' },
    in_progress: { variant: 'purple', label: 'In Progress' },
    review: { variant: 'blue', label: 'In Review' },
    completed: { variant: 'green', label: 'Completed' },
    cancelled: { variant: 'gray', label: 'Cancelled' },
    approved: { variant: 'green', label: 'Approved' },
    revision_requested: { variant: 'yellow', label: 'Revision Requested' },
    revised: { variant: 'blue', label: 'Revised' },
    rejected: { variant: 'red', label: 'Rejected' },
    delivered: { variant: 'green', label: 'Delivered' },
    failed: { variant: 'red', label: 'Failed' },
  };

  const config = statusConfig[status] || { variant: 'gray', label: status };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}

export function PriorityBadge({ priority }) {
  const priorityConfig = {
    1: { variant: 'red', label: 'Critical' },
    2: { variant: 'yellow', label: 'High' },
    3: { variant: 'blue', label: 'Medium' },
    4: { variant: 'gray', label: 'Low' },
  };

  const config = priorityConfig[priority] || { variant: 'gray', label: `P${priority}` };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}
