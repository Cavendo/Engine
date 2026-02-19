#!/usr/bin/env python3
"""
Test connection to Cavendo Engine API.

Usage:
    python check_connection.py
"""

import sys
import os
from pathlib import Path

# Add parent directory to path for lib imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.cavendo_client import get_client

def main():
    """Test Cavendo Engine connection."""
    try:
        with get_client() as client:
            # Get current user/agent info
            me = client.me()
            
            print("✅ Connected to Cavendo Engine")
            print(f"Authenticated as: {me.name}")
            print(f"Agent/User ID: {me.id}")
            print(f"Type: {me.type if hasattr(me, 'type') else 'User'}")
            
            return 0
            
    except Exception as e:
        print(f"❌ Connection failed: {str(e)}")
        print("\nTroubleshooting:")
        print("1. Check CAVENDO_URL in .env")
        print("2. Verify Cavendo Engine is running")
        print("3. Confirm CAVENDO_AGENT_KEY is valid")
        return 1

if __name__ == "__main__":
    sys.exit(main())
