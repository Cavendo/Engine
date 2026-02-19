"""
Formatters for displaying Cavendo Engine data.

Provides functions to format tasks, deliverables, and other objects
for display in OpenClaw conversations.
"""

def format_task_list(tasks, format="brief"):
    """
    Format a list of tasks for display.
    
    Args:
        tasks (list): List of Task objects
        format (str): "brief" or "detailed"
        
    Returns:
        str: Formatted output
    """
    if not tasks:
        return "No tasks found."
    
    if format == "brief":
        return _format_task_list_brief(tasks)
    else:
        return _format_task_list_detailed(tasks)

def _format_task_list_brief(tasks):
    """Format tasks as brief list."""
    lines = [f"Found {len(tasks)} task(s):\n"]
    
    # Group by priority
    high = [t for t in tasks if t.priority == 1]
    medium = [t for t in tasks if t.priority == 2]
    low = [t for t in tasks if t.priority == 3 or t.priority == 4]
    
    if high:
        lines.append("**High Priority:**")
        for task in high:
            lines.append(f"  • #{task.id}: {task.title}")
    
    if medium:
        lines.append("\n**Medium Priority:**")
        for task in medium:
            lines.append(f"  • #{task.id}: {task.title}")
    
    if low:
        lines.append("\n**Low Priority:**")
        for task in low:
            lines.append(f"  • #{task.id}: {task.title}")
    
    return "\n".join(lines)

def _format_task_list_detailed(tasks):
    """Format tasks with full details."""
    lines = [f"Found {len(tasks)} task(s):\n"]
    
    for i, task in enumerate(tasks, 1):
        priority_label = _get_priority_label(task.priority)
        lines.append(f"**{i}. #{task.id}: {task.title}**")
        lines.append(f"   Priority: {priority_label}")
        lines.append(f"   Status: {task.status}")
        if hasattr(task, 'description') and task.description:
            desc = task.description[:100] + "..." if len(task.description) > 100 else task.description
            lines.append(f"   Description: {desc}")
        if hasattr(task, 'due_date') and task.due_date:
            lines.append(f"   Due: {task.due_date}")
        lines.append("")  # Blank line between tasks
    
    return "\n".join(lines)

def _get_priority_label(priority):
    """Convert priority number to label."""
    labels = {
        1: "🔴 High",
        2: "🟡 Medium",
        3: "🟢 Low",
        4: "⚪ Minimal"
    }
    return labels.get(priority, f"Priority {priority}")

def format_deliverable(deliverable):
    """
    Format a deliverable for display.
    
    Args:
        deliverable: Deliverable object
        
    Returns:
        str: Formatted output
    """
    lines = [
        f"**Deliverable #{deliverable.id}**",
        f"Title: {deliverable.title}",
        f"Status: {deliverable.status}",
    ]
    
    if hasattr(deliverable, 'summary') and deliverable.summary:
        lines.append(f"\n**Summary:**\n{deliverable.summary}")
    
    if hasattr(deliverable, 'content') and deliverable.content:
        content_preview = deliverable.content[:500] + "..." if len(deliverable.content) > 500 else deliverable.content
        lines.append(f"\n**Content Preview:**\n{content_preview}")
    
    if hasattr(deliverable, 'created_at'):
        lines.append(f"\nCreated: {deliverable.created_at}")
    
    return "\n".join(lines)

def format_sprint_summary(sprint, tasks):
    """
    Format sprint summary with task statistics.
    
    Args:
        sprint: Sprint object
        tasks (list): List of Task objects in sprint
        
    Returns:
        str: Formatted summary
    """
    total = len(tasks)
    completed = len([t for t in tasks if t.status == "completed"])
    in_progress = len([t for t in tasks if t.status == "in_progress"])
    pending = len([t for t in tasks if t.status in ("pending", "assigned")])
    
    lines = [
        f"**Sprint: {sprint.name}**",
        f"Status: {sprint.status}",
        f"\n**Progress:**",
        f"✅ Completed: {completed}/{total} ({completed/total*100:.0f}%)" if total > 0 else "✅ Completed: 0",
        f"🔄 In Progress: {in_progress}",
        f"⏳ Pending: {pending}",
    ]
    
    if hasattr(sprint, 'start_date') and hasattr(sprint, 'end_date'):
        lines.append(f"\n**Timeline:**")
        lines.append(f"Start: {sprint.start_date}")
        lines.append(f"End: {sprint.end_date}")
    
    return "\n".join(lines)
