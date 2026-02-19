"""
Cavendo Engine client wrapper with OpenClaw integration.

Provides a configured CavendoClient instance with settings from .env.
"""

import os
from pathlib import Path
from dotenv import load_dotenv
from cavendo import CavendoClient

# Load environment variables from .env in skill directory
SKILL_DIR = Path(__file__).parent.parent
load_dotenv(SKILL_DIR / ".env")

def get_client():
    """
    Get configured Cavendo Engine client.
    
    Returns:
        CavendoClient: Configured client instance
        
    Raises:
        ValueError: If required environment variables are missing
    """
    url = os.getenv("CAVENDO_URL")
    api_key = os.getenv("CAVENDO_AGENT_KEY")
    
    if not url:
        raise ValueError("CAVENDO_URL not set in .env")
    
    if not api_key:
        raise ValueError("CAVENDO_AGENT_KEY not set in .env")
    
    return CavendoClient(url=url, api_key=api_key)

def should_notify():
    """Check if notifications are enabled."""
    return os.getenv("CAVENDO_NOTIFY_ON_SUBMIT", "true").lower() == "true"

def get_notify_channel():
    """Get notification channel (signal, slack, etc.)."""
    return os.getenv("CAVENDO_NOTIFY_CHANNEL", "signal")

def get_notify_target():
    """Get notification target (phone number, channel ID, etc.)."""
    return os.getenv("CAVENDO_NOTIFY_TARGET")

def should_auto_claim():
    """Check if auto-claim is enabled."""
    return os.getenv("CAVENDO_AUTO_CLAIM", "true").lower() == "true"

def get_auto_claim_priority_min():
    """Get minimum priority for auto-claim (1=high, higher numbers = lower priority)."""
    return int(os.getenv("CAVENDO_AUTO_CLAIM_PRIORITY_MIN", "2"))

def get_max_concurrent():
    """Get maximum concurrent tasks."""
    return int(os.getenv("CAVENDO_MAX_CONCURRENT", "3"))

def get_model_for_priority(priority):
    """
    Get AI model to use based on task priority.

    Args:
        priority (int): Task priority (1=high, 2=medium, 3=low, 4=minimal)

    Returns:
        str: Model identifier (e.g., "anthropic/claude-sonnet-4-6")
    """
    if priority == 1:
        return os.getenv("CAVENDO_MODEL_HIGH", "anthropic/claude-sonnet-4-6")
    elif priority == 2:
        return os.getenv("CAVENDO_MODEL_MEDIUM", "anthropic/claude-haiku-4-5")
    else:
        return os.getenv("CAVENDO_MODEL_LOW", "anthropic/claude-haiku-4-5")
