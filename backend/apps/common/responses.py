from rest_framework.response import Response


def success(data=None, *, status=200, headers=None):
    return Response({"ok": True, "data": data}, status=status, headers=headers)


def error(code, message, *, status=400, headers=None):
    return Response(
        {"ok": False, "error": {"code": code, "message": message}},
        status=status,
        headers=headers,
    )
