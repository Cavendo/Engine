#!/usr/bin/env python3
"""
Check for pending tasks in Cavendo Engine.

Usage:
    python check_tasks.py [--format brief|detailed] [--status pending,assigned] [--priority 1,2,3]
"""

import sys
import argparse
from pathlib import Path

# Add parent directory to path for lib imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.cavendo_client import get_client
from lib.formatters import format_task_list

def main():
    """Check for pending tasks."""
    parser = argparse.ArgumentParser(description="Check Cavendo Engine tasks")
    parser.add_argument("--format", choices=["brief", "detailed"], default="brief")
    parser.add_argument("--status", default="pending,assigned")
    parser.add_argument("--priority", help="Filter by priority (1=high, 2=medium, 3=low)")
    parser.add_argument("--project", help="Filter by project name or ID")
    args = parser.parse_args()
    
    try:
        with get_client() as client:
            # Get tasks
            statuses = args.status.split(",")
            tasks = []
            for status in statuses:
                tasks.extend(client.tasks.list_mine(status=status.strip()))
            
            # Filter by priority if specified
            if args.priority:
                priorities = [int(p) for p in args.priority.split(",")]
                tasks = [t for t in tasks if t.priority in priorities]
            
            # Filter by project if specified
            if args.project:
                project_filter = args.project.lower()
                tasks = [t for t in tasks if getattr(t, 'project_name', '') and project_filter in t.project_name.lower()]
            
            if not tasks:
                print("No tasks found matching criteria.")
                return 0
            
            # Format and display
            output = format_task_list(tasks, format=args.format)
            print(output)
            
            return 0
            
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
