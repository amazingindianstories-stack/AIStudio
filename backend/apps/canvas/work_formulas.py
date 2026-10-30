"""Tiny bounded arithmetic language: numeric fields, literals and + - * /. No eval."""
import ast
import math
from django.db.models import ExpressionWrapper, F, FloatField, Value
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast, NullIf

OPS = (ast.Add, ast.Sub, ast.Mult, ast.Div)


def parse(expression, numeric_fields):
    if not isinstance(expression, str) or len(expression) > 256:
        raise ValueError('Formula must be at most 256 characters.')
    try:
        tree = ast.parse(expression, mode='eval')
    except (SyntaxError, RecursionError) as error:
        raise ValueError('Invalid arithmetic formula.') from error
    if len(list(ast.walk(tree))) > 64:
        raise ValueError('Formula is too complex.')
    def check(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float) and math.isfinite(node.value) and abs(node.value) <= 1e12:
            return
        if isinstance(node, ast.Name) and node.id in numeric_fields:
            return
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            check(node.operand)
            return
        if isinstance(node, ast.BinOp) and isinstance(node.op, OPS):
            check(node.left)
            check(node.right)
            return
        raise ValueError('Use numeric field ids, numbers and + - * / only.')
    check(tree.body)
    return tree.body


def calculate(expression, cells, numeric_fields):
    def visit(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return float(cells.get(node.id) or 0)
        if isinstance(node, ast.UnaryOp):
            return (-1 if isinstance(node.op, ast.USub) else 1) * visit(node.operand)
        a, b = visit(node.left), visit(node.right)
        if isinstance(node.op, ast.Add): return a + b
        if isinstance(node.op, ast.Sub): return a - b
        if isinstance(node.op, ast.Mult): return a * b
        if isinstance(node.op, ast.Div): return a / b
        raise ValueError("Unsupported operator")
    try:
        value = visit(parse(expression, numeric_fields))
        return value if math.isfinite(value) and abs(value) <= 1e15 else None
    except (ValueError, ZeroDivisionError, OverflowError):
        return None


def sql_expression(expression, numeric_fields):
    def visit(node):
        if isinstance(node, ast.Constant): return Value(float(node.value), output_field=FloatField())
        if isinstance(node, ast.Name):
            from django.db.models.functions import Coalesce
            return Coalesce(Cast(KeyTextTransform(node.id, F('cells')), FloatField()), Value(0.0))
        if isinstance(node, ast.UnaryOp): return visit(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        a, b = visit(node.left), visit(node.right)
        if isinstance(node.op, ast.Add): result = a + b
        elif isinstance(node.op, ast.Sub): result = a - b
        elif isinstance(node.op, ast.Mult): result = a * b
        elif isinstance(node.op, ast.Div): result = a / NullIf(b, Value(0.0))
        else: raise ValueError("Unsupported operator")
        return ExpressionWrapper(result, output_field=FloatField())
    return visit(parse(expression, numeric_fields))
