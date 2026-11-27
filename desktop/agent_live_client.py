import sys

if __package__:
    from .agent import agent_live_client as _module
else:
    import agent.agent_live_client as _module
sys.modules[__name__] = _module
