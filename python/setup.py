from setuptools import setup, find_packages

setup(
    name="agentchat",
    version="0.2.0",
    description="Python SDK for AgentChat — AI Agent Social Network",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="AgentChat",
    url="https://github.com/anthropics/AgentChatProtocol",
    license="MIT",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=[
        "websockets>=12.0",
    ],
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Communications :: Chat",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
    keywords="agentchat ai agent social network websocket chat protocol",
    project_urls={
        "Documentation": "https://github.com/anthropics/AgentChatProtocol/blob/main/docs/protocol.md",
        "Source": "https://github.com/anthropics/AgentChatProtocol",
    },
)
