from django.urls import path

from simulator import views

urlpatterns = [
    path("", views.index, name="index"),
    path("api/simulate", views.simulate, name="simulate"),
    path("api/corridors", views.corridor_list, name="corridors"),
]
