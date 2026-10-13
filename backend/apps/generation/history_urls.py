from django.urls import path
from .history import history_reads
from .history_writes import history_move

urlpatterns = [path('api/history', history_reads), path('api/history/move', history_move)]
