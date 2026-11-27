import sys

if __package__:
    from .agent import agent_stdio as _module
else:
    import agent.agent_stdio as _module
sys.modules[__name__] = _module
