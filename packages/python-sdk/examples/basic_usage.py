"""
Basic usage example for the Cavendo Python SDK.

This example demonstrates the fundamental workflow of an AI agent
interacting with Cavendo Engine.
"""

import os
from cavendo import (
    CavendoClient,
    TaskStatus,
    CavendoError,
    AuthenticationError,
    NotFoundError,
)


def main() -> None:
    """Main function demonstrating basic SDK usage."""

    # Initialize the client
    # You can provide credentials directly or use environment variables:
    # - CAVENDO_URL: Base URL of the Cavendo Engine
    # - CAVENDO_AGENT_KEY: Your agent's API key
    client = CavendoClient(
        url=os.getenv("CAVENDO_URL", "http://localhost:3001"),
        api_key=os.getenv("CAVENDO_AGENT_KEY"),
    )

    try:
        # Get information about the current agent
        agent = client.me()
        print(f"Logged in as: {agent.name}")
        print(f"Agent type: {agent.type}")
        print(f"Scopes: {', '.join(agent.scopes)}")
        print(f"Accessible projects: {agent.project_ids}")
        print()

        # List all pending tasks
        pending_tasks = client.tasks.list_all(status=TaskStatus.PENDING)
        print(f"Found {len(pending_tasks)} pending tasks")
        for task in pending_tasks[:5]:  # Show first 5
            print(f"  - [{task.id}] {task.title} (priority: {task.priority})")
        print()

        # Get the next task to work on
        next_task = client.tasks.next()
        if not next_task:
            print("No tasks available")
            return

        print(f"Working on task: {next_task.title}")
        print(f"Description: {next_task.description}")

        # Get full context for the task
        context = client.tasks.context(next_task.id)
        print(f"\nTask context:")
        print(f"  Project: {context.project}")
        print(f"  Related tasks: {len(context.related_tasks)}")
        print(f"  Knowledge docs: {len(context.knowledge)}")
        print(f"  Previous deliverables: {len(context.previous_deliverables)}")

        # Mark task as in progress
        client.tasks.update_status(next_task.id, TaskStatus.IN_PROGRESS)
        print("\nTask marked as in progress")

        # Search knowledge base for relevant information
        if context.project:
            project_id = context.project.get("id")
            results = client.knowledge.search(
                query=next_task.title,
                project_id=project_id,
                limit=5,
            )
            print(f"\nFound {len(results)} relevant knowledge documents:")
            for result in results:
                print(f"  - {result.document.title} (score: {result.score:.2f})")

        # Simulate doing work...
        work_result = f"## Analysis of {next_task.title}\n\nThis is the agent's work output."

        # Submit a deliverable
        deliverable = client.deliverables.submit(
            task_id=next_task.id,
            title=f"Deliverable for: {next_task.title}",
            content=work_result,
            content_type="markdown",
            metadata={
                "agent": agent.name,
                "version": 1,
            },
        )
        print(f"\nSubmitted deliverable {deliverable.id}")

        # Update task status to review
        client.tasks.update_status(
            next_task.id,
            TaskStatus.REVIEW,
            progress={"deliverable_id": deliverable.id},
        )
        print("Task marked for review")

        # Check for feedback on previous deliverables
        my_deliverables = client.deliverables.mine(status="revision_requested")
        if my_deliverables:
            print(f"\n{len(my_deliverables)} deliverables need revision:")
            for d in my_deliverables:
                feedback = client.deliverables.get_feedback(d.id)
                if feedback:
                    print(f"  - [{d.id}] {d.title}")
                    print(f"    Feedback: {feedback.content[:100]}...")

    except AuthenticationError as e:
        print(f"Authentication failed: {e}")
    except NotFoundError as e:
        print(f"Resource not found: {e}")
    except CavendoError as e:
        print(f"API error: {e}")
    finally:
        # Always close the client when done
        client.close()


if __name__ == "__main__":
    main()
