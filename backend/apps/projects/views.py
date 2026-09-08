from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.common.activity import log_activity

from . import projects_service


@api_view(["GET", "POST"])
def projects(request):
    if request.method == "GET":
        # Atomically ensure a default project exists so the UI always has a home.
        return Response({"projects": projects_service.ensure_default_project()})

    body = request.data or {}
    op = body.get("op")

    if op == "createProject":
        name = (body.get("name") or "").strip()
        if not name:
            return Response({"error": "Name required."}, status=400)
        result = projects_service.create_project(name, str(request.user.id))
        return Response(result)

    if op == "renameProject":
        return Response(
            {
                "projects": projects_service.rename_project(
                    body.get("projectId"), (body.get("name") or "").strip()
                )
            }
        )

    if op == "setBrief":
        return Response(
            {"projects": projects_service.set_brief(body.get("projectId"), body.get("brief") or "")}
        )

    if op == "deleteProject":
        log_activity(str(request.user.id), "delete_project", {"projectId": body.get("projectId")})
        return Response({"projects": projects_service.delete_project(body.get("projectId"))})

    if op == "createFolder":
        name = (body.get("name") or "").strip()
        if not name:
            return Response({"error": "Name required."}, status=400)
        result = projects_service.create_folder(body.get("projectId"), name)
        return Response(result)

    if op == "renameFolder":
        return Response(
            {
                "projects": projects_service.rename_folder(
                    body.get("folderId"), (body.get("name") or "").strip()
                )
            }
        )

    if op == "deleteFolder":
        log_activity(
            str(request.user.id),
            "delete_folder",
            {"projectId": body.get("projectId"), "folderId": body.get("folderId")},
        )
        return Response({"projects": projects_service.delete_folder(body.get("folderId"))})

    return Response({"error": "Unknown op."}, status=400)
